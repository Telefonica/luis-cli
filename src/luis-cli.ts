/**
* @license
* Copyright 2016 Telefónica I+D
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
* http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

import { LuisApp } from './luis-app';

import * as fs from 'fs';
import * as path from 'path';
import * as commander from 'commander';
import * as logger from 'logops';

interface InterfaceCLI extends commander.ICommand {
    export?: string;
    import?: string;
    update?: string;
    appid?: string;
    subid?: string;
    appname?: string;
    verbose?: boolean;
}

const cli: InterfaceCLI = commander
    .option('-e, --export [filename]', 'Export application to JSON file. You need to specify an appid.')
    .option('-i, --import [filename]', 'Import application from JSON file. You will get a new appid.')
    .option('-u, --update [filename]', 'Update application from JSON file. You need to specify an appid.')
    .option('-a, --appid [application_id]', 'Microsoft LUIS application id. Optional depending on what you want to do.')
    .option('-s, --subid [subscription_id]', 'Microsoft LUIS subscription id. REQUIRED.')
    .option('-n, --appname [subscription_name]', 'Microsoft LUIS subscription name. Only needed for importing.')
    .option('-v, --verbose', 'Set verbose mode.')
    .parse(process.argv);

if (cli.verbose) {
    logger.setLevel('DEBUG');
}

let luisApp: LuisApp = new LuisApp(cli.appid, cli.subid);

if (cli.export) {
    luisApp.export()
        .then((appObj: Object) => {
            let dirname: string = path.normalize(path.dirname(cli.export));

            if (!fs.statSync(dirname).isDirectory()) {
                fs.mkdirSync(dirname);
            }

            let formattedAppObj = JSON.stringify(appObj, null, 2);
            fs.writeFileSync(cli.export, formattedAppObj);
            logger.debug('App exported to file %s', cli.export);

            console.log(cli.appid);
        })
        .catch((err) => {
            logger.error(err);
            process.exit(1);
        });
} else if (cli.import) {
    let appData = JSON.parse(fs.readFileSync(cli.import, 'utf-8'));

    luisApp.import(cli.appname, appData)
        .then((appId: string) => {
            logger.debug('App data has been imported under appId %s', appId);

            // Write the appId to stdout to use luis-cli output in other tools
            console.log(appId);
        })
        .catch((err) => {
            logger.error(err);
            process.exit(1);
        });
} else if (cli.update) {
    let appData = JSON.parse(fs.readFileSync(cli.update, 'utf-8'));
    logger.debug('Updating application');
    luisApp.updateUtterances(appData)
        .then(data => {
            logger.debug(data, 'Application Updated');
            console.log(cli.appid);
        })
        .catch(err => {
            logger.error(err);
            process.exit(1);
        });
} else {
    console.log('Select --import or --export or --update operation');
    process.exit(1);
}
