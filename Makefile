SHELL := /bin/bash
es = $(ES_URL)
index = $(ES_index)

default: highlights

deleteIndex:
	curl -XDELETE $(es)/$(index)

createIndex:
	curl -XPOST -d @mappings.json $(es)/$(index)

sendToES=true
toES = $(sendToES) && parallel -j2 --pipe -N1000 \
	"curl -XPUT \
		--write-out '%{http_code} ' \
		--output /dev/null \
		--silent \
		\"$(es)/$(index)/_bulk\" \
		--data-binary @-\
	"; echo

buckets = $$(redis-cli keys 'object:*' | egrep 'object:[0-9]+$$$$' | cut -d ':' -f 2 | sort -g)
streamRedis:
	@for bucket in $(buckets); do \
		>&2 echo $$bucket; \
		redis-cli --raw hgetall object:$$bucket | grep -v "<br />" | while read id; do \
			if [[ $$id = *[[:digit:]]* ]]; then \
				read -r json; \
				if echo $$json | grep 'Error with id' > /dev/null; then continue; fi; \
				json=$$(sed -e 's/%C2%A9/©/g; s/%26Acirc%3B%26copy%3B/©/g; \
					s|http:\\\/\\\/api.artsmia.org\\\/objects\\\/||; \
					s/o_/ō/g; \
					s/u_/ū/g; \
					s/&amp;/&/g; \
					s/"provenance":"",//g; \
					s/,"see_also":\[""\]//g; \
					s/,"portfolio":"From "//; \
					s/"artist":"Artist: /"artist":"/; \
				' <<<$$json); \
				echo $$id; \
				echo $$json; \
			fi; \
		done; \
	done

action = "index"
objects:
	@[[ -d bulk ]] || mkdir bulk; \
	file=bulk/objects-$(action).json; \
	([[ -f $$file ]] && cat $$file || \
	(make streamRedis | while read id; do \
		read -r json; \
		echo "{ \"$(action)\" : { \"_type\" : \"object_data\", \"_id\" : \"$$id\" } }"; \
		if [ "$(action)" == 'index' ]; then \
			echo "$$json"; \
		else \
			echo "{"doc":$$json}"; \
		fi; \
	done | tee $$file)) | $(toES)

clean:
	rm -rf bulk/*
reindex: deleteIndex createIndex update
update: objects highlights \
	departments departmentHighlights \
	recent deaccessions relatedContent \
	completions tags accessionHighlights \
	maintainUpdatedImageData

highlights = 278 529 1218 1226 1244 1348 1355 1380 4866 8023 1629 3183 3520 60728 113926 114602 108860 109118 115836 116725 1270 1411 1748 4324 5788 1721 107241 2725 2175 6613 125830 4428 4383 109122
highlights:
	echo $(highlights) | tr ' ' '\n' | while read id; do \
		echo "{\"update\": {\"_type\": \"object_data\", \"_id\": \"$$id\"}}"; \
		echo "{\"doc\": {\"highlight\": \"true\"}}"; \
	done | tee bulk/highlights.ldjson | $(toES)

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
	done | tee bulk/departmentHighlights.ldjson | $(toES)

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
	@curl --silent $(internalAPI)/accessions/deaccessions/json | jq -r '.[] | .id, .date, .reason' | while read objectId; do \
		read date; \
		read reason; \
		reason=$$(sed 's|Deaccessioned - ||' <<<$$reason); \
		echo "{ \"update\" : {\"_type\" : \"object_data\", \"_id\" : \"$$objectId\" } }"; \
		echo "{ \"doc\": { \"deaccessioned\": \"true\", \"deaccessionedDate\": \"$$date\", \"deaccessionedReason\": \"$$reason\" } }"; \
	done | tee bulk/deaccessioned.json | $(toES)

relateds = 3dmodels artstories stories audio-stops newsflashes adopt-a-painting exhibitions catalogs timelines conservation videos
relatedContent:
	for type in $(relateds); do \
		>&2 echo $$type; \
		name=$$(sed 's/s$$//' <<<$$type); \
		cat ../collection-links/$$type | jq -s -r -c --arg type $$type ' \
			map(. as $$related \
			| (.objectId? // (map(.objectId) | join(" "))) | split(" ") \
			| map($$related + {_id: .})) \
			| flatten \
			| group_by(._id) \
			| map( \
				{update: {_type: "object_data", _id: .[0]._id}}, \
				{doc: {"related:\($$type)": .}} \
			)[] \
		'; \
	done | tee bulk/related.json | $(toES)

completions = "artist title"
completions = "artist"
completions:
	@highlights=$$(make highlightIds); \
	file=bulk/completions.json; \
	([ -e $$file ] && cat $$file || (make streamRedis | while read objectId; do \
		read -r json; \
		for type in $$(echo $(completions) | tr ' ' '\n'); do \
			value=$$(jq -r ".$$type" <<<$$json | sed 's/"//g; s/;.*$$//; s/ and.*$$//;' | tr -d '\r\n'); \
			output=$$(echo $$value | sed 's/(.*)//'); \
			if [ ! -z "$${value// }" ]; then \
				key="$$type"_suggest; \
				if echo $$highlights | grep " $$objectId " > /dev/null; then key=highlight_"$$key"; fi; \
				terms=$$(echo $$value | sed 's/ in\| of\| a\| the\| an\|\.\|\(\|\)//g' | tr ' ' ',' | sed 's/,/\",\"/g'); \
				echo "{ \"update\" : {\"_type\" : \"object_data\", \"_id\" : \"$$objectId\" } }"; \
				echo "{ \"doc\": {\"$$key\": {\"input\": [\"$$terms\"], output: \"$$value\"} } }"; \
			fi; \
		done; \
	done | tee $$file)) | $(toES);

highlightIds:
	@highlights=$$(echo $(highlights) $$(csvcut -c1 department_features.csv)); \
	echo " $$highlights "

updateId:
	@updateOrIndex=$$(curl --silent $$ES_URL/$(index)/object_data/$$id \
		| jq -r 'if .found == true then "_update" else "" end'); \
	curlMethod=`[ "$$updateOrIndex" == '_index' ] && echo PUT || echo POST`; \
	file=`ls ~/tmp/collection/{,private/}objects/$$(($(id)/1000))/$$id.json 2>/dev/null`; \
	([[ -f $$file ]] && cat $$file || \
	  curl --silent http://api.artsmia.org/objects/$$id/full/json) \
	| jq '{doc: .}' | \
	sed -e 's/%C2%A9/©/g; s/%26Acirc%3B%26copy%3B/©/g; \
		s|http://api.artsmia.org/objects/||; \
		s/o_/ō/g; \
		s/&amp;/&/g; \
		s/^.*"provenance":"",//g; \
	' \
	| tee /dev/tty \
	| curl -X$$curlMethod $$ES_URL/$(index)/object_data/$$id/$$updateOrIndex \
	  --data-binary @-\

volumes:
	cat bulk/volumes.json | $(toES)

accessionHighlights:
	curl --silent 'http://api.artsmia.org/accessions/highlights' | tee bulk/accessionHighlights.json | \
		jq -c 'map([ \
			{update: {_type: "object_data", _id: .id}}, \
			{doc: {accessionHighlight: true, accessionDate: .date, accessionHighlightText: .text}} \
		]) | flatten | .[]' | tee bulk/accessionHighlights.ldjson | $(toES)

# pass in path to downloaded image files to update ES image metadata outside of API
updateImageData:
	find $(images) -type f | grep 'tif\|jpg' \
			| xargs exiftool -json -TransmissionReference -ImageWidth -ImageHeight \
	| jq -c 'map([ \
			{update: {_type: "object_data", _id: .TransmissionReference}}, \
			{doc: {image: "valid", image_width: .ImageWidth, image_height: .ImageHeight}} \
		]) | flatten | .[]' | tee /dev/tty | $(toES)

maintainUpdatedImageData:
	make updateImageData images=manually-added-images/ index=objects1
	make updateImageData images=manually-added-images/ index=objects2

restoreFromBulkCache:
	cat bulk/$(file) | $(toES)

sendArbitraryJson:
	cat $(file) | $(toES)

alias:
	curl -XDELETE $(es)/objects
	curl -XPOST $(es)/_aliases -d \
		'{"actions": [{ "add": {"alias": "objects", "index": "$(index)"}}]}'

artistsMixNMatch:
	curl -o artistsMixNMatch.json 'https://tools.wmflabs.org/mix-n-match/api.php?query=download2&catalogs=786&columns=%7B%22exturl%22%3A1%2C%22username%22%3A1%2C%22aux%22%3A0%2C%22dates%22%3A0%2C%22location%22%3A0%2C%22multimatch%22%3A1%7D&hidden=%7B%22any_matched%22%3A0%2C%22firmly_matched%22%3A0%2C%22user_matched%22%3A0%2C%22unmatched%22%3A0%2C%22automatched%22%3A0%2C%22name_date_matched%22%3A0%2C%22aux_matched%22%3A0%2C%22no_multiple%22%3A0%7D&format=json'

tunnelES:
	ssh -Nf -L 9200:localhost:9200 es

.PHONY: departments tags
