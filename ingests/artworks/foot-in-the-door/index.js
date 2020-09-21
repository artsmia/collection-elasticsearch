/** @format
 */
const fs = require('fs')
const path = require('path')
const parseSync = require('csv-parse/lib/sync')

const submissionCsv = path.join(__dirname, 'submissions.csv')
const rows = fs.readFileSync(submissionCsv)

async function read(args = {}) {
  const submissions = parseSync(fs.readFileSync(submissionCsv), {
    columns: true,
    skip_empty_lines: true,
  })

  await formfacadeImageDownload(submissions)
}
function stream() {}
function transform(data) {}
function load(data) {}

module.exports = { read, stream, transform }

const imageFilenameColumnName =
  'Upload a single image of your artwork (square 1:1 aspect ratio, 2000x2000, jpg or png, up to 10 MB)'

/** Formfacade import
 */
const util = require('util')
const writeFile = util.promisify(fs.writeFile)
const puppeteer = require('puppeteer')

/** FormFacade was used for uploading images to this google form beacuse of limits in google's own form
 * file uploader (which caused a BIG problem when we found out that it required users to log in before uploading)
 *
 * This uses puppeteer to log in to Formfacade and download the images. It also re-names the file to: `2020_fitd_<date>_<last name>`
 */
async function formfacadeImageDownload(submissions) {
  const firstImage = submissions[0][imageFilenameColumnName]
  const _chromiumDataDir = './chromium_data'
  const chromiumDataDir = path.join(__dirname, 'chromium_data')

  console.info('formfacadeImageDownload', { firstImage, chromiumDataDir })

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: chromiumDataDir, // save browser data to persist formfacade login
  })

  console.info('.')

  const page = await browser.newPage()
  await page.goto(firstImage)

  let loginButton
  try {
    loginButton = await page.waitForSelector('button.mdl-button', {
      timeout: 5000,
    })
  } catch (e) {
    console.info('already logged in?!?')
  }

  if (loginButton) {
    await loginButton.click()

    const loginTarget = await browser.waitForTarget(target =>
      target.url().match('accounts.google.com')
    )
    const loginPopup = await loginTarget.page()

    const emailSelector = 'input[type="email"]'
    const email = await loginPopup.waitForSelector(emailSelector)
    await loginPopup.$eval(
      emailSelector,
      el => (el.value = process.env.FITD_FORMFACADE_LOGIN)
    )
    let next = await loginPopup.waitForSelector(
      '[data-primary-action-label] button'
    )
    await next.click()

    const pwSel = 'input[name="hiddenPassword"]'
    const pw = await loginPopup.waitForSelector(pwSel)
    await loginPopup.$eval(pwSel, el => (el.value = process.env.FITD_FORMFACADE_PW))
    let next2 = await loginPopup.waitForSelector('#passwordNext button')
    await loginPopup.waitFor(1000)
    await loginPopup.$eval('#passwordNext button', el => el.click())

    await page.waitForNavigation({ timeout: 0 })
  }

  // Increase max size for the browser session
  await page._client.send('Network.enable', {
    maxResourceBufferSize: 1024 * 1204 * 300,
    maxTotalBufferSize: 1024 * 1204 * 700,
  })

  // const submissions = allImages()
  //   .filter(img => !img.match('.pdf'))
  //   .slice(0, 1)

  console.info(`about to download ${submissions.length} submissions`)

  const downloads = await submissions.reduce(
    async (prevPromise, submission) => {
      await prevPromise

      const imageAccessUrl = submission[imageFilenameColumnName]
      const submissionName = submission['Name'].replace(/\s+/g, '-')
      const submissionTimestamp = submission['Timestamp']
      const submissionIsoTime = new Date(submissionTimestamp)
        .toISOString()
        .split('.0')[0]

      const uploadedFilename = imageAccessUrl.split('/').reverse()[0]
      const ext = uploadedFilename.split('.').reverse()[0]
      const filename = `2020_fitd_${submissionIsoTime}_${submissionName}.${ext}`
      const filepath = path.join(__dirname, `images/${filename}`)

      const alreadyDownloaded = fs.existsSync(filepath)
      const skip = alreadyDownloaded || !filename

      // write json data to a 'sidecar' file
      // TODO modify this to use the data transform
      fs.writeFileSync(
        filepath.replace(ext, 'json'),
        JSON.stringify(submission, null, 2)
      )

      if (skip) return page.waitFor(0)

      console.info('downloading image…', { imageAccessUrl })
      const [nav, imageAccessPage] = await Promise.all([
        page.waitForNavigation(),
        page.goto(imageAccessUrl),
      ])
      // once the FormFacade page loads, it takes a few seconds to grant access
      // when it navigates again, that should be the image page?
      // TODO watch out for the session getting logged out mid-download?
      // const imagePage = await page.waitForNavigation() // HTTPResponse
      const storage = await page.waitForFunction(() =>
        window.location.hostname.match('storage')
      )
      const image = await page.goto(await page.url())

      console.info('…image loaded, extracting buffer…')
      // TODO doesn't work for PDFs?
      // https://github.com/puppeteer/puppeteer/issues/1248
      // see above where pdfs are filtered out
      const buffer = await image.buffer()
      console.info('buffer read, writing file…')
      await writeFile(filepath, buffer)
      console.info('…file written, waiting 3 seconds')

      return page.waitFor(3000)
    },
    Promise.resolve()
  )

  await downloads
  await browser.close()
  console.info('done')
}
