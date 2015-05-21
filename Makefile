SHELL := /bin/bash
index = $(ES_index)

deleteIndex:
	curl -XDELETE $(ES_URL)/$(index)

createIndex:
	curl -XPOST -d @mappings.json $(ES_URL)/$(index)

buckets = $$(redis-cli keys 'object:*' | egrep 'object:[0-9]+$$$$' | cut -d ':' -f 2 | sort -g)
objects:
	[[ -d bulk ]] || mkdir bulk; \
	for bucket in $(buckets); do \
		echo $$bucket; \
		file=bulk/$$bucket.json; \
		[[ -f $$file ]] && sleep 1 || \
		redis-cli --raw hgetall object:$$bucket | grep -v "<br />" | while read id; do \
			if [[ $$id = *[[:digit:]]* ]]; then \
				read -r json; \
				json=$$(sed -e 's/%C2%A9/©/g; s/%26Acirc%3B%26copy%3B/©/g; s|http:\\\/\\\/api.artsmia.org\\\/objects\\\/||; s/o_/ō/g' <<<$$json); \
				echo "{ \"index\" : { \"_index\" : \"$(index)\", \"_type\" : \"object_data\", \"_id\" : \"$$id\" } }" >> $$file; \
				echo "$$json" >> $$file; \
			fi; \
		done; \
		curl -XPUT "$(ES_URL)/_bulk" --data-binary @$$file; \
	done

reindex: deleteIndex createIndex objects highlights

highlights = 278 529 1218 1226 1244 1348 1355 1380 4866 8023 1629 1721 3183 3520 60728 113926 114602 108860 109118 115836 116725 1270 1411 1748 4324 5788
highlights:
	echo $(highlights) | tr ' ' '\n' | while read id; do \
		echo "{\"update\": {\"_index\": \"$(index)\", \"_type\": \"object_data\", \"_id\": \"$$id\"}}"; \
		echo "{\"doc\": {\"highlight\": \"true\"}}"; \
	done | curl -v -XPUT "$(ES_URL)/_bulk" --data-binary @-
