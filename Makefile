SHELL := /bin/bash
index = $(ES_index)

default: highlights

deleteIndex:
	curl -XDELETE $(ES_URL)/$(index)

createIndex:
	curl -XPOST -d @mappings.json $(ES_URL)/$(index)

toES = parallel -j2 --pipe -N1000 \
	"curl -XPUT \
	  --write-out '%{http_code} ' \
		--output /dev/null \
	  --silent \
	  \"$(ES_URL)/$(index)/_bulk\" \
	  --data-binary @-\
	"; echo

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
				json=$$(sed -e 's/%C2%A9/©/g; s/%26Acirc%3B%26copy%3B/©/g; \
					s|http:\\\/\\\/api.artsmia.org\\\/objects\\\/||; \
					s/o_/ō/g; \
					s/"provenance":"",//g; \
				' <<<$$json); \
				echo "{ \"index\" : { \"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
				echo "$$json"; \
			fi; \
		done | tee $$file); \
	done | $(toES)

clean:
	rm -rf bulk/*
reindex: deleteIndex createIndex update
update: objects highlights imageRights \
	departments departmentHighlights \
	tags recent deaccessions relatedContent

highlights = 278 529 1218 1226 1244 1348 1355 1380 4866 8023 1629 1721 3183 3520 60728 113926 114602 108860 109118 115836 116725 1270 1411 1748 4324 5788
highlights:
	echo $(highlights) | tr ' ' '\n' | while read id; do \
		echo "{\"update\": {\"_type\": \"object_data\", \"_id\": \"$$id\"}}"; \
		echo "{\"doc\": {\"highlight\": \"true\"}}"; \
	done | $(toES)

# Detailed image rights don't make it through our API currently.
# `rights.xlsx` comes from TMS, gets converted to a CSV (`id, rights statement`),
# and sent into ES
rights.csv: rights.xslx
	j -l $< | while read sheet; do \
		j -s "$$sheet" $< >> $@; \
	done
	gsed -i '2,$${ /^ObjectID/d }; /^$$/d' $@

imageRights: rights.csv
	file=bulk/image-rights.json; \
	([ -e $$file ] && cat $$file || (tail -n+3 $< | csvcut -c1,2 | while read line; do \
		id=$$(cut -d',' -f1 <<<$$line); \
		rights=$$(cut -d',' -f2 <<<$$line); \
		echo "{ \"update\" : {\"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
		echo "{ \"doc\": { \"rights\": \"$$rights\" } }"; \
	done | tee $$file)) | $(toES)

departments:
	@curl --silent $(internalAPI)/departments/ | jq -r 'map([.department, .department_id])[][]' | while read name; do \
		read deptId; \
		curl --silent $(internalAPI)/departments/$$deptId | jq -r 'map(.object_id)[]' | while read id; do \
			echo "{ \"update\" : {\"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
			echo "{ \"doc\": { \"department\": \"$$name\" } }"; \
		done; \
	done | $(toES)

departmentHighlights:
	@csvcut -c1,2 department_features.csv | while read feature; do \
		objectId=$$(cut -d',' -f1 <<<$$feature); \
		dept=$$(cut -d',' -f2 <<<$$feature); \
		echo "{ \"update\" : {\"_type\" : \"object_data\", \"_id\" : \"$$objectId\" } }"; \
		echo "{ \"doc\": { \"featured\": \"true\" } }"; \
	done | $(toES)

tags:
	@redis="redis-cli --raw"; \
	file=bulk/tags.json; \
	([ -e $$file ] && cat $$file || ($$redis keys 'object:*:tags' | while read key; do \
		id=$$(sed 's/object:\|:tags//g' <<<$$key); \
		tags=$$($$redis smembers $$key \
		| sed 's/^.*\\u0.*//; s/\"//g' \
		| grep -v 'artist\|http' \
		| tr '\n' ' '); \
		echo "{ \"update\" : {\"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
		echo "{ \"doc\": { \"tags\": \"$$tags\" } }"; \
	done | sed 's/\\\|\\r\|\\n/ /g' | tee $$file)) | $(toES)

recent:
	@curl --silent $(internalAPI)/accessions/recent/json | jq '.[].id' | while read objectId; do \
		echo "{ \"update\" : {\"_type\" : \"object_data\", \"_id\" : \"$$objectId\" } }"; \
		echo "{ \"doc\": { \"recent\": \"true\" } }"; \
	done | tee bulk/recent.json | $(toES)

deaccessions:
	@curl --silent $(internalAPI)/accessions/deaccessions/json | jq -r '.[] | [.id, .date][]' | while read objectId; do \
		read date; \
		echo "{ \"update\" : {\"_type\" : \"object_data\", \"_id\" : \"$$objectId\" } }"; \
		echo "{ \"doc\": { \"deaccessioned\": \"true\", \"deaccessionedDate\": \"$$date\" } }"; \
	done | tee bulk/deaccessioned.json | $(toES)

relatedContent:
	for type in 3dmodels artstories stories audio-stops newsflashes; do \
		name=$$(sed 's/s$$//' <<<$$type); \
		cat ../collection-links/$$type | while read ids; do \
		  read json; \
			tr ' ' '\n' <<<$$ids | while read objectId; do \
				echo "{ \"update\" : {\"_type\" : \"object_data\", \"_id\" : \"$$objectId\" } }"; \
				echo "{ \"doc\": { \"related:$$type\": \"true\" } }"; \
			done; \
		done; \
	done | tee bulk/related.json | $(toES)

completions:
	for type in artist title; do \
		file=bulk/$$type-completions.json; \
		[ -e $$file ] && cat $$file || (find ~/tmp/collection/objects/1 -name "*.json" | while read file; do \
			objectId=$$(echo $$file | rev | cut -d'/' -f1 | rev | sed 's/.json//'); \
			value=$$(jq -r ".$$type" $$file | sed 's/"//g'); \
			if [ ! -z "$${value// }" ]; then \
				echo $$value | sed 's/;.*$$//' | sed 's/in|of|a|the|an//g' | tr ' ' '\n' | while read term; do \
					echo "{ \"update\" : {\"_type\" : \"object_data\", \"_id\" : \"$$objectId\" } }"; \
					echo "{ \"doc\": {\""$$type"_suggest\": {\"input\": \"$$term\", output: \"$$value\"} } }"; \
				done; \
			fi; \
		done | tee $$file) | $(toES); \
	done;

.PHONY: departments tags
