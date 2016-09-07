import { LuisApp } from './luis-app';

import * as fs from 'fs';
import * as path from 'path';
import * as program from 'commander';

interface InterfaceCLI extends commander.ICommand {
    export?: string;
    import?: string;
    update?: string;
    appid?: string;
    subid?: string;
    appname?: string;
}

const cli: InterfaceCLI = program
    .option('-e, --export [filename]', 'Export application to JSON file. You need to specify an appid.')
    .option('-i, --import [filename]', 'Import application from JSON file. You will get a new appid.')
    .option('-u, --update [filename]', 'Update application from JSON file. You need to specify an appid.')
    .option('-a, --appid [application_id]', 'Microsoft LUIS application id. Optional depending on what you want to do.')
    .option('-s, --subid [subscription_id]', 'Microsoft LUIS subscription id. REQUIRED.')
    .option('-n, --appname [subscription_name]', 'Microsoft LUIS subscription name. Only needed for importing.')
    .parse(process.argv);

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
            console.log('App exported to file %s', cli.export);
        })
        .catch((err) => {
            console.log(JSON.stringify(err));
        });
} else if (cli.import) {
    let appData = JSON.parse(fs.readFileSync(cli.import, 'utf-8'));

    luisApp.import(cli.appname, appData)
        .then((appId: string) => {
            console.log('App data has been imported under appId %s', appId);
        })
        .catch((err) => {
            console.log(JSON.stringify(err));
        });
} else if (cli.update) {
    let appData = JSON.parse(fs.readFileSync(cli.update, 'utf-8'));
    console.log('Updating application');
    luisApp.updateUtterances(appData);
} else {
    console.log('Select --import or --export or --update operation');
}
