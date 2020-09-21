imageSizeSparkline:
	@echo $$(du -hs images/* | sort -h | cut -f1 | head -1; \
			du images/* | sort -n | cut -f1 | spark; \
			du -hs images/* | sort -h | cut -f1 | tail -1)

watch:
	rewatch formfacade-image-download.js -c 'node formfacade-image-download.js'
