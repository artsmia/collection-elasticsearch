SHELL := /bin/bash
index = $(ES_index)

deleteIndex:
	curl -XDELETE $(ES_URL)/$(index)

createIndex:
	curl -XPOST -d @mappings.json $(ES_URL)/$(index)

toES = parallel -j2 --pipe -N1000 "curl -XPUT --write-out '%{http_code} ' --output /dev/null --silent \"$(ES_URL)/_bulk\" --data-binary @-"; echo

buckets = $$(redis-cli keys 'object:*' | egrep 'object:[0-9]+$$$$' | cut -d ':' -f 2 | sort -g)
objects:
	[[ -d bulk ]] || mkdir bulk; \
	for bucket in $(buckets); do \
		>&2 echo $$bucket; \
		file=bulk/$$bucket.json; \
		[[ -f $$file ]] && cat $$file || \
		(redis-cli --raw hgetall object:$$bucket | grep -v "<br />" | while read id; do \
			if [[ $$id = *[[:digit:]]* ]]; then \
				read -r json; \
				json=$$(sed -e 's/%C2%A9/©/g; s/%26Acirc%3B%26copy%3B/©/g; s|http:\\\/\\\/api.artsmia.org\\\/objects\\\/||; s/o_/ō/g' <<<$$json); \
				echo "{ \"index\" : { \"_index\" : \"$(index)\", \"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
				echo "$$json"; \
			fi; \
		done | tee $$file); \
	done | $(toES)

clean:
	rm -rf bulk/*
reindex: deleteIndex createIndex update
update: objects highlights imageRights \
	departments departmentHighlights \
	tags recent

highlights = 278 529 1218 1226 1244 1348 1355 1380 4866 8023 1629 1721 3183 3520 60728 113926 114602 108860 109118 115836 116725 1270 1411 1748 4324 5788
highlights:
	echo $(highlights) | tr ' ' '\n' | while read id; do \
		echo "{\"update\": {\"_index\": \"$(index)\", \"_type\": \"object_data\", \"_id\": \"$$id\"}}"; \
		echo "{\"doc\": {\"highlight\": \"true\"}}"; \
	done | $(toES)

# Detailed image rights don't make it through our API currently.
# `rights.xlsx` comes from TMS, gets converted to a CSV (`id, rights statement`),
# and sent into ES
rights.csv: rights.xslx
	j -l $< | while read sheet; do \
		j -s "$$sheet" $< >> $@; \
	done
	sed -i '2,$${ /^ObjectID/d }; /^$$/d' $@

imageRights: rights.csv
	file=bulk/image-rights.json; \
	([ -e $$file ] && cat $$file || (tail -n+3 $< | csvcut -c1,2 | while read line; do \
		id=$$(cut -d',' -f1 <<<$$line); \
		rights=$$(cut -d',' -f2 <<<$$line); \
		echo "{ \"update\" : { \"_index\" : \"$(index)\", \"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
		echo "{ \"doc\": { \"image_rights_type\": \"$$rights\" } }"; \
	done | tee $$file)) | $(toES)

departments:
	@curl --silent $(internalAPI)/departments/ | jq -r 'map([.department, .department_id])[][]' | while read name; do \
		read deptId; \
		curl --silent $(internalAPI)/departments/$$deptId | jq -r 'map(.object_id)[]' | while read id; do \
			echo "{ \"update\" : { \"_index\" : \"$(index)\", \"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
			echo "{ \"doc\": { \"department\": \"$$name\" } }"; \
		done; \
	done | $(toES)

tags:
	@redis="redis-cli --raw"; \
	file=bulk/tags.json; \
	([ -e $$file ] && cat $$file || ($$redis keys 'object:*:tags' | while read key; do \
		id=$$(sed 's/object:\|:tags//g' <<<$$key); \
		echo "{ \"update\" : { \"_index\" : \"$(index)\", \"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
		echo "{ \"doc\": { \"tags\": \"$$($$redis smembers $$key | sed 's/^.*\\u0.*//; s/\"//g' | tr '\n' ' ')\" } }"; \
	done | sed 's/\\\|\\r\|\\n/ /g' | tee $$file)) | $(toES)

.PHONY: departments tags
