/** @format
 */
const fs = require('fs')
const util = require('util')
const writeFile = util.promisify(fs.writeFile)
const puppeteer = require('puppeteer')

function read(args = {}) {}
// function stream() {}
function transform(data) {}
function load(data) {}

module.exports = { read, stream, transform }

/** Formfacade import
 */
const fs = require('fs')
const util = require('util')
const writeFile = util.promisify(fs.writeFile)
const puppeteer = require('puppeteer')

const firstImage = `https://formfacade.com/uploaded/1FAIpQLSeSjl3222iNB_k9R8TPlH-4wKC8mnvjswlVAQQshokfQQFn1w/ecc47670-f1e3-11ea-abbc-33a1dfe84f14/1045735876/200908_MathewsAmy.jpg`
const testAnother = `https://formfacade.com/uploaded/1FAIpQLSeSjl3222iNB_k9R8TPlH-4wKC8mnvjswlVAQQshokfQQFn1w/468f22c0-f38f-11ea-8acb-c34ff1b949cd/1045735876/Banning%20-%20Sun%20in%20the%20Hall%2C%202020%2C%2010%22%20x%2010%22%2C%20oil%20on%20panel.jpg`

async function run() {
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: './chromium_data', // save browser data to persist formfacade login
  })
  const page = await browser.newPage()
  await page.goto(testAnother)

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

  const images = allImages()
    .filter(img => !img.match('.pdf'))
    .slice(0, 50)

  console.info(`about to download ${images.length} images`)

  const downloads = await images.reduce(async (prevPromise, imageAccessUrl) => {
    await prevPromise

    const filename = imageAccessUrl.split('/').reverse()[0]
    const filepath = `images/${filename}`
    const filenameWithRow = imageAccessUrl.split('/').reverse()[0] // TODO add row?
    const filepathWRow = `images/${filenameWithRow}`

    const alreadyDownloaded =
      fs.existsSync(filepath) || fs.existsSync(filepathWRow)
    const skip = alreadyDownloaded || !filename

    // move `:filename`, without row included to, `:row - :filename`
    // so the image can be easily connected back to the spreadsheet?
    if (fs.existsSync(filepath) || fs.existsSync(filepathWRow)) {
    }

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
  }, Promise.resolve())

  await downloads
  await browser.close()
  console.info('done')
}

run()

function allImages() {
  const images = fs
    .readFileSync('./images.txt', { encoding: 'utf-8' })
    .split('\n')

  return images
}
