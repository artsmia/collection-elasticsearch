SHELL := /bin/bash
es = $(ES_URL)
index = $(ES_index)

default: highlights

deleteIndex:
	curl -XDELETE $(es)/$(index)

createIndex:
	curl -XPOST -d @mappings.json $(es)/$(index)

# TODO for accessionHighlights this needs to be POST instead of PUT?
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
	done | tee $$file))

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

relateds = 3dmodels artstories stories audio-stops newsflashes adopt-a-painting exhibitions catalogs timelines conservation videos inspiredByMia marks-of-genius-audio-beta
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
	done | tee bulk/related.json

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

useLocal=true
updateId:
	updateOrIndex=$$(curl --silent $$ES_URL/$(index)/object_data/$$id \
		| jq -r 'if .found == true then "_update" else "_index" end'); \
	curlMethod=`[ "$$updateOrIndex" == '_index' ] && echo PUT || echo POST`; \
	file=`ls ~/tmp/collection/{,private/}objects/$$(($(id)/1000))/$$id.json 2>/dev/null`; \
	([[ $(useLocal) = true && -f $$file ]] && cat $$file || \
	  curl --silent http://api.artsmia.org/objects/$$id/full/json) \
	| jq '{doc: .}' | \
	sed -e 's/%C2%A9/©/g; s/%26Acirc%3B%26copy%3B/©/g; \
		s|http://api.artsmia.org/objects/||; \
		s/o_/ō/g; \
		s/&amp;/&/g; \
		s/^.*"provenance":"",//g; \
	' \
	| tee /dev/tty \
	| curl -X$$curlMethod $$ES_URL/$(index)/object_data/$$id/$$updateOrIndex -d @-

volumes:
	cat bulk/volumes.json | $(toES)

# `accessions/highlights` is only accessible on the internal API
# TODO - push the contents of the file if it exists, and only make the API call
# when the file doesn't?
# curl --silent 'http://api.artsmia.org/accessions/highlights' | tee bulk/accessionHighlights.json
accessionHighlights:
	cat bulk/accessionHighlights.json | \
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

removeField:
	@ls ../collection-info/lists/black-history-month.md | while read listFile; do \
			json=$$(m2j $$listFile | jq .[]); \
			listId=$$(jq -r '.listId' <<<$$json); \
			echo $$listFile -- $$listId; \
			jq -r '.ids[]' <<<$$json | jq -s -c --arg listId $$listId 'map([ \
				{update: {_type: "object_data", _id: .}}, \
				{"script": "ctx._source.remove(\"list:bhm\")"} \
		  ]) | flatten | .[]' | tee bulk/$$listId-list.ldjson; \
		done


lists:
	@ls ../collection-info/lists/*.md | while read listFile; do \
			json=$$(m2j $$listFile | jq '.[]'); \
			listId=$$(jq -r '.listId' <<<$$json); \
			echo $$listFile -- $$listId; \
			jq -r '.ids[]' <<<$$json | jq -s -c --arg listId $$listId 'map([ \
				{update: {_type: "object_data", _id: .}}, \
				{doc: {"list:\($$listId)": true}} \
		  ]) | flatten | .[]' | tee bulk/$$listId-list.ldjson; \
		done
listLinks:
	ls bulk/*-list.ldjson | tail -n+2 | sed 's|bulk/||; s|-list.ldjson||' | parallel 'echo https://collections.artsmia.org/search/_exists_:\"list:{}\"'

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

updateGalleryFromAPI:
	  echo "updating existing ES gallery objects…"
	  echo "updating from API…"
		curl --silent http://api.artsmia.org/gallery/G$(galleryId) \
				| jq -r '.objects | map(.id)[]' \
				| parallel --bar "make updateId id={1} index=object{2} useLocal=false >/dev/null" ::::+ - ::: 1 2 >/dev/null
		ssh collections "./clear-collections-cache.sh G$(galleryId)"
		echo "objects updated and cache cleared!"

footInTheDoor:
	cat fitd.ldjson | jq -s -c 'map([ \
			  {index: {_type: "foot-in-the-door", _id: .id}}, \
				. \
		  ])[][]' > bulk/foot-in-the-door.ldjson

# TODO
# FITD alongside mia objects in the index, but give each a different _type?
# mia: _type mia | artsmia
# fitd: _type fitd | fitf20 | foot-in-the-door-2020
deleteIndexFitD:
	curl -XDELETE $(es)/foot-in-the-door

createIndexFitD:
	curl -XPOST -d @mappings.json $(es)/foot-in-the-door

reindexFitD: deleteIndexFitD createIndexFitD footInTheDoor
	cat bulk/foot-in-the-door.ldjson | curl -v localhost:9200/foot-in-the-door/_bulk \
			-XPOST --data-binary @-

creativityAcademy:
	cat ingests/artworks/creativity-academy-2021/creativity-academy.ldjson | jq -s -c 'map([ \
			  {index: {_type: "creativity-academy-2021", _id: .id}}, \
				. \
		  ])[][]' > bulk/creativity-academy-2021.ldjson

deleteIndexCA21:
	curl -XDELETE $(es)/creativity-academy-2021

createIndexCA21:
	curl -XPOST -d @mappings.json $(es)/creativity-academy-2021

reindexCA21: deleteIndexCA21 createIndexCA21 creativityAcademy
	cat bulk/creativity-academy-2021.ldjson | curl -v localhost:9200/creativity-academy-2021/_bulk \
			-XPOST --data-binary @-

artInBloom:
	cat ingests/artworks/art-in-bloom-2021/aib2021.ldjson | jq -s -c 'map([ \
			  {index: {_type: "art-in-bloom-2021", _id: .id}}, \
				. \
		  ])[][]' > bulk/art-in-bloom-2021.ldjson

deleteIndexAIB21:
	curl -XDELETE $(es)/art-in-bloom-2021

createIndexAIB21:
	curl -XPOST -d @mappings.json $(es)/art-in-bloom-2021

reindexAIB21: artInBloom deleteIndexAIB21 createIndexAIB21
	cat bulk/art-in-bloom-2021.ldjson | curl -v localhost:9200/art-in-bloom-2021/_bulk \
			-XPOST --data-binary @-

.PHONY: departments tags
