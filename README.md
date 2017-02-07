# Luis Command-line Interface

Simple command-line interface to interact with Microsoft LUIS APIs.

## Install

```sh
$ npm install -g @telefonica/luis-cli
```

## Usage

This CLI uses the LUIS API to automate the following tasks:
* update an existing LUIS app with the model of a local json file.
* export an existing LUIS app to the specified local json file.

Notes:
* This tool assumes the use of "native LUIS app json files", the ones you get when you export an app.
* When updating, it update utterances, intents, entities and phrase lists, creating the new ones and
  deleting the ones no longer used. It also train an publish the app.

Type `luis-cli -h` to get more info about the available commands and general options.
To know more about one command, type `luis-cli <command> -h`.


## LICENSE

Copyright 2017 [Telefónica I+D](http://www.tid.es)

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
