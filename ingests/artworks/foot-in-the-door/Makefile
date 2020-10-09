imageSizeSparkline:
	@echo $$(du -hs images/* | sort -h | cut -f1 | head -1; \
			du images/* | sort -n | cut -f1 | spark; \
			du -hs images/* | sort -h | cut -f1 | tail -1)

watch:
	rewatch formfacade-image-download.js -c 'node formfacade-image-download.js'

syncWithGdrive:
	rclone sync --progress images kolsen-artsmia-gdrive:"Foot in the door submission images"

imagesToS3:
	s3cmd sync -P images/thumbs/800/ s3://foot-in-the-door-2020/800/
