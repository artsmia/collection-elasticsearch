<!-- @format -->

Google doc with all submissions:
https://docs.google.com/spreadsheets/d/1uhaJC0UK0pzRpnnTXQSV1hisvOTKU51GP9NagujwcOw/edit?usp=sharing

The submissions spreadsheet includes a file URL from formfacade:

https://formfacade.com/uploaded/1FAIpQLSeSjl3222iNB_k9R8TPlH-4wKC8mnvjswlVAQQshokfQQFn1w/ecc47670-f1e3-11ea-abbc-33a1dfe84f14/1045735876/200908_MathewsAmy.jpg

which when properly logged in, redirects to a google storage backend with a key
provided by FormFacade:

https://storage.googleapis.com/formfacade-public/1FAIpQLSeSjl3222iNB_k9R8TPlH-4wKC8mnvjswlVAQQshokfQQFn1w%2Fecc47670-f1e3-11ea-abbc-33a1dfe84f14%2F1045735876%2F200908_MathewsAmy.jpg?GoogleAccessId=firebase-adminsdk-pve0p%40formfacade.iam.gserviceaccount.com&Expires=1599766888&Signature=JRoio5LF9OUqU9cfuqo231%2FeS2QRaxComl0DIVyuHM7k8MbFtO3%2Ba0kbNV5o9pxUNUlrmShVbdfW4VXU9ZuCkXBhx3UL8zCWE9K5w90whallpe0SAsnsaEzZ1uUdbp3P%2FvJApZPuvRnX1sEC0a9ySoyCQ02MD%2Ft5lQAj6F4s%2FVbSyAmvmtkGO2%2FDgkiO06pXn0Ikna3gvG%2BDMsa55eHz7pnagKwmMvabQEebt874cJDQ4efaDb%2B0Mk7hea4y0e3NviIsvYwFKmwIGaHCuMtRI4yZKia724M6LgGil1dKyXa7%2FZIJMG7biwXerIschBw026yhzWHfS6lblq7VsEtKtw%3D%3D

That URL uses the same key as the formfacade.com/uploaded URL - presumably
`<identifier for our form>/<identifier for this upload>`, which has the `/`
URL-encoded to `%2F` but otherwise appears the same in the
storage.googleapis.com link. Unfortunately they don't share the
`?GoogleAccessId` so I can't use one key to pull multiple images. That's a big
bad dead-end. I'll need to find a way to simulate login to formfacade with curl,
wget, or puppeteer in the worst case, and pull the file with a valid access
token that way.

………

`formfacade-image-download.js` opens up puppeteer, logs in with my info, and
saves the image to `./images/:filename`.

NEXT UP: upload all images to an S3 bucket by `:filename` and add a column to
the spreadsheet with that URL?

Then I could expand to a script that reads the spreadsheet CSV, uploads each
image that hasn't been uploaded yet to S3, and the spreasheet should mostly have
link-able images
