SHELL := /bin/bash
index = $(ES_index)

deleteIndex:
	curl -XDELETE $(ES_URL)/$(index)

createIndex:
	curl -XPOST -d @mappings.json $(ES_URL)/$(index)

buckets = $$(redis-cli keys 'object:*' | egrep 'object:[0-9]+$$$$' | cut -d ':' -f 2 | sort -g)
objects:
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

reindex: deleteIndex createIndex objects
