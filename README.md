# Luis Command-line Interface

Simple command-line interface to interact with Microsoft LUIS APIs.

## Usage

This CLI uses LUIS APIs to automate following tasks:
* export an existing LUIS app to the specified local json file.
* create (import) a new LUIS app from a local json file.
* update the utterances (or examples) of an existing LUIS App as specified in a local json file.

Note:
* This tool assumes the use of "native LUIS app json files", the ones you get when you export an app. You must follow that schema.
* For the moment, when updating, it only considers utterances. It modifies existing ones, creates new ones and removes obsolete ones as needed.
* App update also automatically triggers training and app publishment.

```
npm install @telefonica/luis-cli

luis-cli [options]

Options:

  -h, --help                         Show usage information
  -e, --export [filename]            Export application to JSON file. You need to specify an appid.
  -i, --import [filename]            Import application from JSON file. You will get a new appid, don't have to specify one.
  -u, --update [filename]            Update application from JSON file. You need to specify an appid.
  -a, --appid [application_id]       Microsoft LUIS application id. Optional depending on what you want to do.
  -s, --subid [subscription_id]      Microsoft LUIS subscription id. Always REQUIRED.
  -n, --appname [subscription_name]  Microsoft LUIS subscription name. Only needed for importing.
  -v, --verbose                      Enable verbose mode
```

## LICENSE

Copyright 2016 [Telefónica I+D](http://www.tid.es)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.