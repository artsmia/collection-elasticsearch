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

reindex: deleteIndex createIndex objects highlights imageRightsToES departments tags

highlights = 278 529 1218 1226 1244 1348 1355 1380 4866 8023 1629 1721 3183 3520 60728 113926 114602 108860 109118 115836 116725 1270 1411 1748 4324 5788
highlights:
	echo $(highlights) | tr ' ' '\n' | while read id; do \
		echo "{\"update\": {\"_index\": \"$(index)\", \"_type\": \"object_data\", \"_id\": \"$$id\"}}"; \
		echo "{\"doc\": {\"highlight\": \"true\"}}"; \
	done | curl -v -XPUT "$(ES_URL)/_bulk" --data-binary @-

# Detailed image rights don't make it through our API currently.
# `rights.xlsx` comes from TMS, gets converted to a CSV (`id, rights statement`),
# and sent into ES
rights.csv: rights.xslx
	j -l $< | while read sheet; do \
		j -s "$$sheet" $< >> $@; \
	done
	sed -i '2,$${ /^ObjectID/d }; /^$$/d' $@

imageRightsToES: rights.csv
	file=bulk-image-rights.json; \
	[ -e $$file ] || tail -n+3 $< | csvcut -c1,2 | while read line; do \
		id=$$(cut -d',' -f1 <<<$$line); \
		rights=$$(cut -d',' -f2 <<<$$line); \
		echo "{ \"update\" : { \"_index\" : \"$(index)\", \"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
		echo "{ \"doc\": { \"image_rights_type\": \"$$rights\" } }"; \
	done >> $$file; \
	split -l 1000 $$file; \
	ls x* | while read file; do \
		curl -XPUT "$(ES_URL)/_bulk" --data-binary @$$file; \
		sleep 2; \
	done
	rm x*

departments:
	@curl --silent $(internalAPI)/departments/ | jq -r 'map([.department, .department_id])[][]' | while read name; do \
		read deptId; \
		curl --silent $(internalAPI)/departments/$$deptId | jq -r 'map(.object_id)[]' | while read id; do \
			echo "{ \"update\" : { \"_index\" : \"$(index)\", \"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
			echo "{ \"doc\": { \"department\": \"$$name\" } }"; \
		done; \
	done >> departments.bulk;
	split -l 1000 departments.bulk
	ls x* | while read file; do \
		curl -XPUT "$(ES_URL)/_bulk" --data-binary @$$file; \
		sleep 2; \
	done
	rm departments.bulk x*

tags:
	@redis="redis-cli --raw"; \
	$$redis keys 'object:*:tags' | while read key; do \
		id=$$(sed 's/object:\|:tags//g' <<<$$key); \
		echo "{ \"update\" : { \"_index\" : \"$(index)\", \"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
		echo "{ \"doc\": { \"tags\": \"$$($$redis smembers $$key | sed 's/^.*\\u0.*//; s/\"//g' | tr '\n' ' ')\" } }"; \
	done | sed 's/\\\|\\r\|\\n/ /g' | parallel -j2 --pipe -N1000 "curl -XPUT --write-out '%{http_code} ' --output /dev/null --silent \"$(ES_URL)/_bulk\" --data-binary @-";

.PHONY: departments tags
