/** @format
 */
const fs = require('fs')
const path = require('path')
const execSync = require('child_process').execSync
const parseSync = require('csv-parse/lib/sync')
const ndjson = require('ndjson')

const submissionCsv = path.join(__dirname, 'submissions.csv')
const rows = fs.readFileSync(submissionCsv)

const downloadImages = false

function imageSize(filepath) {
  try {
    const out = execSync(`vipsheader "${filepath}"`, { encoding: 'utf-8' })
    const [_, width, height] = out.match(/: ([0-9]+)x([0-9]+)/)
    return [width, height].map(n => Number(n))
  } catch (e) {
    return [null, null]
  }
}

async function processImages(submissions) {
  if (downloadImages) {
    const images = await formfacadeImageDownload(submissions)
  }

  const renameAndMoveImages = false
  if (renameAndMoveImages) {
    const replacedImages = await replaceImages()
  }

  // TODO extract image metadata (width/height)
  // here instead if in the transform?
  // Or does it make more sense to do that from the transform,
  // which is probably where EXIF data will need to be written
  // back into the image files?
}

async function replaceImages(submissions) {
  submissions.map(data => {
    const replacementImageName = data['Replacement Image Filename']
    //
    // Handle e-mailed replacement images
    if (replacementImageName) {
      const rootPathExists = fs.existsSync(filepathRoot)
      const bucketPathExists = fs.existsSync(filepath)
      const alreadyRenamed = rootPathExists || bucketPathExists

      console.info('has replacement image?', {
        index,
        replacementImageName,
        alreadyRenamed,
        filepath,
      })

      if (!alreadyRenamed) {
        fs.writeFileSync(jsonFilePath, JSON.stringify(data, null, 2))
        fs.copyFileSync(
          path.join(
            __dirname,
            `images/hand-submitted-images/${replacementImageName}`
          ),
          filepath
        )
      }
    }
  })
}

async function read(args = {}) {
  const submissions = parseSync(fs.readFileSync(submissionCsv), {
    columns: true,
    skip_empty_lines: true,
  })

  await processImages(submissions)

  const stream = ndjson.stringify()
  submissions.map((s, index) => {
    stream.write({ ...s, __index: index + 2 })
  })

  return stream
}
// function stream() {}
function transform(data) {
  const index = data.__index

  // Process image(s)
  // * this step might need to copy a replacement image into the images directory structure
  //   if that image was emailed in to VE to replace the uploaded image, or if the uploaded
  //   image was invalid
  //
  // TODO de-dupe filename assignment with code copied from `formfacadeImageDownload`
  const imageAccessUrl = data[imageFilenameColumnName]
  const uploadedFilename = imageAccessUrl.split('/').reverse()[0]
  let ext = uploadedFilename.split('.').reverse()[0]
  const submissionName = data['Name'].replace(/\s+/g, '-')
  const submissionTimestamp = data['Timestamp']
  let submissionIsoTime
  try {
    submissionIsoTime = new Date(submissionTimestamp)
      .toISOString()
      .split('.0')[0]
  } catch (e) {
    console.error('couldnt parse submission timestamp', {
      submissionTimestamp,
      index,
    })
  }
  let imageFilename = `2020_fitd_${submissionIsoTime}_${submissionName}.${ext}`
  const bucket = Math.max(1, Math.ceil(index / 135)) // clamp so index 0 goes in bucket 1
  let filepath = path.join(__dirname, `images/${bucket}`, imageFilename)
  const filepathRoot = path.join(__dirname, `images/${imageFilename}`)
  const replacementImage = data['Replacement Image Filename']
  if (replacementImage) {
    const replacementImagePath = path.join(
      __dirname,
      'images/hand-submitted-images',
      replacementImage
    )
    ext = replacementImage.split('.').reverse()[0]
    imageFilename = `2020_fitd_${submissionIsoTime}_${submissionName}.${ext}`
    filepath = path.join(__dirname, `images/${bucket}`, imageFilename)
    const bucketPathExists = fs.existsSync(filepath)

    if (!bucketPathExists)
      try {
        fs.copyFileSync(replacementImagePath, filepath)
      } catch (e) {
        console.info('error moving image', {
          replacementImagePath,
          filepath,
          e,
        })
      }
  }
  // end TODO

  // TODO fetching image dimensions is SLOW
  // Make this an option to run on ingest, and somehow
  // cache the data when it is generated?
  const validImage = filepath && !filepath.match(/pdf/i)
  let width = undefined
  let height = undefined
  let dimensions = [width, height]
  try {
    if (validImage) {
      dimensions = imageSize(filepath)
    }
  } catch (e) {
    console.error('error checking image size', { filepath, e })
  }
  // end TODO

  // Generate a hash to use as the ID instead of using numeric ID?
  //
  // (what's 'extracting' vs transforming? the hash is probably a 'transform' but
  // image dimensions are an 'extract'?)
  // TODO generate the mystical hash

  const KEYWORDS_KEY =
    'Add keywords (optional): These will operate as search terms related to your submission.'
  const IMAGE_DESCRIPTION_KEY = 'Image description for digital accessibility'
  const FINAL_REVIEW_KEY = `Final Review (X = do not publish, empty = publish, ? = there's still an issue to resolve)`

  // prettier-ignore
  // const classifications = [
  //   'Ceramics', 'Paintings', 'Photography', 'Drawings', 'Prints',
  //   'Sculpture', 'Textiles', 'Mixed Media',
  // ]
  // const classifIdx = Math.floor(Math.random()*10)%classifications.length
  const classification = data['Category [Mia Enters]']

  const public_access = data[FINAL_REVIEW_KEY].match(/x/i) ? 0 : 1

  return {
    id: index, // hash of the submitted image filename?
    accession_number: `L2020.FITD.${index - 1}`,
    creditline: 'likewise',
    title: data.Title,
    artist: data.Name,
    dated: data['Year'],
    medium: data['Medium'],
    keywords: data[KEYWORDS_KEY],
    description: data[IMAGE_DESCRIPTION_KEY],
    dimension: data.Dimensions,
    classification,
    image: imageFilename,
    public_access,
    // image: validImage ? 'valid' : 'invalid',
    image_width: dimensions[0],
    image_height: dimensions[1],
  }
}
function load(data) {
  // gather up the data after its been transformed
  // and push it into elasticsearch
}

module.exports = { read, transform }

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

  // console.info('formfacadeImageDownload', { firstImage, chromiumDataDir })

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: chromiumDataDir, // save browser data to persist formfacade login
  })

  // console.info('.')

  const page = await browser.newPage()
  await page.goto(firstImage)

  let loginButton
  try {
    loginButton = await page.waitForSelector('button.mdl-button', {
      timeout: 5000,
    })
  } catch (e) {
    // console.info('already logged in?!?')
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
    await loginPopup.$eval(
      pwSel,
      el => (el.value = process.env.FITD_FORMFACADE_PW)
    )
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

  // console.info(`about to download ${submissions.length} submissions`)

  const downloads = await submissions.reduce(
    async (prevPromise, submission, index) => {
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
      const filepathRoot = path.join(__dirname, `images/${filename}`)
      const bucket = Math.max(1, Math.ceil(index / 135)) // clamp so index 0 goes in bucket 1
      const filepath = path.join(__dirname, `images/${bucket}`, filename)
      const jsonFilePath = filepath.replace(ext, 'json')

      const rootPathExists = fs.existsSync(filepathRoot)
      const bucketPathExists = fs.existsSync(filepath)
      const alreadyDownloaded = rootPathExists || bucketPathExists

      const bucketPath = path.dirname(filepath)
      if (!fs.existsSync(bucketPath)) {
        fs.mkdirSync(bucketPath, { recursive: true })
      }

      // move file from images/:name to images/:bucket/:name
      if (rootPathExists && !bucketPathExists) {
        fs.renameSync(filepathRoot, filepath)
        fs.renameSync(filepathRoot.replace(ext, 'json'), jsonFilePath)
      }

      const skip = alreadyDownloaded || !filename

      // write json data to a 'sidecar' file
      fs.writeFileSync(jsonFilePath, JSON.stringify(submission, null, 2))

      if (skip) return page.waitFor(0)

      // TODO modify this so it also looks at `Replacement Image Filename`
      // in the CSV and connects that to `images/hand-submitted-images`
      // instead of downloading from FormFacade
      // console.info('downloading image…', { imageAccessUrl })

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

      // console.info('…image loaded, extracting buffer…')
      // TODO doesn't work for PDFs?
      // https://github.com/puppeteer/puppeteer/issues/1248
      // see above where pdfs are filtered out
      const buffer = await image.buffer()
      // console.info('buffer read, writing file…')
      await writeFile(filepath, buffer)
      // console.info('…file written, waiting 1 seconds')

      return page.waitFor(1000)
    },
    Promise.resolve()
  )

  await downloads
  await browser.close()
  // console.info('done')
}
