/**
* @license
* Copyright 2017 Telefónica I+D
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

import * as fs from 'fs';
import * as commander from 'commander';
import { sprintf } from 'sprintf-js';
import * as colors from 'colors';
import { LuisTrainer, LuisTrainerConfig, UpdateEvent } from './luis-trainer';
import { Luis as LuisModel } from '@telefonica/language-model-converter/lib/luis-model';


const DEFAULT_LUIS_ENDPOINT = 'https://westus.api.cognitive.microsoft.com';

enum Commands { Update, Export, CheckPredictions };
let command: Commands;

let runner: Promise<number> = null;

interface ProgramOptions extends commander.ICommand {
    parent?: ProgramOptions;  // When using commands, `parent` holds options from the main program
    endpoint?: string;
    applicationId?: string;
    filename?: string;
    subscriptionKey?: string;
}

const program: ProgramOptions = commander
    .usage('command [options]')
    .option('-e, --endpoint <endpoint>', `LUIS endpoint (also got from the LUIS_ENDPOINT env var) [${DEFAULT_LUIS_ENDPOINT}]`,
        DEFAULT_LUIS_ENDPOINT)
    .option('-s, --subscription-key <subscription-key>', 'LUIS subscription key (also got from the LUIS_SUBSCRIPTION_KEY env var)');

program
    .command('update')
    .description('Update a LUIS application with the model from <filename>')
    .option('-a, --application-id <application-id>', 'LUIS application id (also got from the LUIS_APPLICATION_ID env var)')
    .option('-f, --filename <filename>', 'JSON file containing the model to upload to the LUIS application')
    .action(options => selectRunner(Commands.Update, options))
    .on('--help', function() {
        console.log('  Example:');
        console.log();
        console.log(`    Update an application using the model from the file 'model.json':`);
        console.log('      $ luis-cli update -a XXX -f model.json -s YYY');
    });

program
    .command('export')
    .description('Export a LUIS application to the given <filename>')
    .option('-a, --application-id <application-id>', 'LUIS application id (also got from the LUIS_APPLICATION_ID env var)')
    .option('-f, --filename <filename>', 'file where the LUIS application will be exported to')
    .action(options => selectRunner(Commands.Export, options))
    .on('--help', function() {
        console.log('  Example:');
        console.log();
        console.log(`    Export an application to the file 'model.json':`);
        console.log('      $ luis-cli export -a XXX -f model.json -s YYY');
    });

program
    .command('check')
    .description(`Check whether each example's intent and entities match the predicted ones and export the differences to <filename>`)
    .option('-a, --application-id <application-id>', 'LUIS application id (also got from the LUIS_APPLICATION_ID env var)')
    .option('-f, --filename <filename>', `JSON file containing the examples incorrectly predicted`)
    .action(options => selectRunner(Commands.CheckPredictions, options))
    .on('--help', function() {
        console.log('  Example:');
        console.log();
        console.log(`    Check whether an application correctly predict intents and entities and save differences to 'errors.json':`);
        console.log('      $ luis-cli check -a XXX -f errors.json -s YYY');
    });

program.parse(process.argv);

if (!runner) {
    // No command has been selected
    printError('supported commands: update, export, check');
}

runner.then((exitCode: number) => {
    process.exit(exitCode || 0);
});


function selectRunner(command: Commands, options: ProgramOptions) {
    // Get values from env vars if not provided via options
    let endpoint = options.parent.endpoint || process.env.LUIS_ENDPOINT;
    let subscriptionKey = options.parent.subscriptionKey || process.env.LUIS_SUBSCRIPTION_KEY;
    let applicationId = options.applicationId || process.env.LUIS_APPLICATION_ID;
    let filename = options.filename;

    // Check mandatory options
    if (!subscriptionKey) {
        printError('unknown LUIS subscription key. Provide one through the `-s, --subscription-key` option ' +
            'or the `LUIS_SUBSCRIPTION_KEY` env var.');
    }
    if ((command === Commands.Update || command === Commands.Export || command === Commands.CheckPredictions)
        && !applicationId) {
        printError('unknown LUIS application id. Provide one through the `-a, --application-id` option ' +
            'or the `LUIS_APPLICATION_ID` env var.');
    }

    let luisTrainerConfig: LuisTrainerConfig = {
        luisApiClientConfig: {
            baseUrl: endpoint,
            subscriptionKey: subscriptionKey,
            applicationId: applicationId
        }
    };
    let luisTrainer: LuisTrainer = new LuisTrainer(luisTrainerConfig);

    switch (command) {
        case Commands.Update:
            if (!filename) {
                printError('missing JSON file from which the model will be read. Provide one through the `-f, --filename` option.');
            }
            runner = updateApp(luisTrainer, applicationId, filename);
            break;

        case Commands.Export:
            if (!filename) {
                printError('missing JSON file to which the application will be exported. Provide one through the `-f, --filename` option.');
            }
            runner = exportApp(luisTrainer, applicationId, filename);
            break;

        case Commands.CheckPredictions:
            if (!filename) {
                printError('missing JSON file to which the differences will be saved. Provide one through the `-f, --filename` option.');
            }
            runner = checkPrediction(luisTrainer, applicationId, filename);
            break;
    }
}

function updateApp(luisTrainer: LuisTrainer, applicationId: string, filename: string): Promise<number> {
    let model: LuisModel.Model;
    try {
        model = JSON.parse(fs.readFileSync(filename, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') {
            printError(`the file ${filename} does not exist.`);
        } else {
            handleError(err);
        }
    }

    console.log(`Updating the application ${applicationId} with the model from "${filename}"...`);
    console.log();
    luisTrainer.on('startUpdateIntents', (stats: UpdateEvent) => {
        console.log(`Updating intents: deleting ${stats.delete} intents no longer needed ` +
            `and creating ${stats.create} new intents...`);
    });
    luisTrainer.on('endUpdateIntents', () => {
        console.log('Intents successfully updated.');
        console.log();
    });
    luisTrainer.on('startUpdateEntities', (stats: UpdateEvent) => {
        console.log(`Updating entities: deleting ${stats.delete} entities no longer needed ` +
            `and creating ${stats.create} new entities...`);
    });
    luisTrainer.on('endUpdateEntities', () => {
        console.log('Entities successfully updated.');
        console.log();
    });
    luisTrainer.on('startUpdatePhraseLists', (stats: UpdateEvent) => {
        console.log(`Updating phrase lists: deleting ${stats.delete} phrase lists no longer needed ` +
            `and creating ${stats.create} new phrase lists...`);
    });
    luisTrainer.on('endUpdatePhraseLists', () => {
        console.log('Phrase lists successfully updated.');
        console.log();
    });
    luisTrainer.on('startGetAllExamples', () => {
        process.stdout.write('Getting all the existing examples ');
        luisTrainer.on('getExamples', (first: number, last: number) => process.stdout.write('.'));
    });
    luisTrainer.on('endGetAllExamples', (numberOfExamples: number) => {
        console.log(`\nGot ${numberOfExamples} examples.`);
    });
    luisTrainer.on('startUpdateExamples', (stats: UpdateEvent) => {
        console.log(`Updating examples: deleting ${stats.delete} examples no longer needed ` +
            `and creating ${stats.create} new examples...`);

        let deleted = 0;
        luisTrainer.on('deleteExample', () => {
            deleted++;
            process.stdout.write(`\rDeleted ${deleted}/${stats.delete} examples ` +
                `(${(deleted / stats.delete * 100).toFixed(0)}%)`);
            if (deleted >= stats.delete) {
                console.log();
            }
        });

        let created = 0;
        luisTrainer.on('createExampleBunch', (bunchLength: number) => {
            created += bunchLength;
            process.stdout.write(`\rCreated ${created}/${stats.create} examples ` +
                `(${(created / stats.create * 100).toFixed(0)}%)`);
            if (created >= stats.create) {
                console.log();
            }
        });
    });
    luisTrainer.on('endUpdateExamples', () => {
        console.log('Examples successfully updated.');
        console.log();
    });
    luisTrainer.on('startTraining', () => {
        process.stdout.write('Training the application...');
        luisTrainer.on('trainingProgress', (finished: number, total: number) => {
            process.stdout.write(`\rTraining the application... ${(finished / total * 100).toFixed(0)}% completed`);
            if (finished >= total) {
                console.log();
                console.log();
            }
        });
    });
    luisTrainer.on('startPublish', () => {
        console.log('Publishing the application...');
    });
    luisTrainer.on('endPublish', () => {
        console.log('Application successfully published.');
        console.log();
    });

    return luisTrainer.update(model)
        .then(() => {
            console.log('The application has been successfully updated');
            return 0;
        })
        .catch(handleError);
}

function exportApp(luisTrainer: LuisTrainer, applicationId: string, filename: string): Promise<number> {
    console.log(`Exporting the application ${applicationId} to "${filename}"...`);
    return luisTrainer.export()
        .then(model => {
            fs.writeFileSync(filename, JSON.stringify(model, null, 2));
            console.log(`The application has been exported to "${filename}"`);
            return 0;
        })
        .catch(handleError);
}

function checkPrediction(luisTrainer: LuisTrainer, applicationId: string, filename: string): Promise<number> {
    console.log(`Checking predictions for the application ${applicationId}...`);

    luisTrainer.on('startGetAllExamples', () => {
        process.stdout.write('Getting all the existing examples ');
        luisTrainer.on('getExamples', (first: number, last: number) => process.stdout.write('.'));
    });
    luisTrainer.on('endGetAllExamples', (numberOfExamples: number) => {
        console.log(`\nGot ${numberOfExamples} examples.`);
    });

    return luisTrainer.checkPredictions()
        .then(predictionResult => {
            if (predictionResult.errors.length) {
                let intentErrors = predictionResult.errors.filter(error => error.predictedIntent).length;
                let entityErrors = predictionResult.errors.filter(error => error.predictedEntities).length;
                let tokenizationErrors = predictionResult.errors.filter(error => error.tokenizedText).length;
                console.log('\nThe following prediction errors have been found:');
                if (intentErrors) {
                    console.log(`  - ${colors.bold(intentErrors.toString())} examples whose predicted intent is wrong.`);
                }
                if (entityErrors) {
                    console.log(`  - ${colors.bold(entityErrors.toString())} examples whose predicted entities are wrong.`);
                }
                if (tokenizationErrors) {
                    console.log(`  - ${colors.bold(tokenizationErrors.toString())} examples have been incorrectly tokenized.`);
                }
                fs.writeFileSync(filename, JSON.stringify(predictionResult.errors, null, 2));
                console.log(`\nAll the prediction errors have been saved in "${filename}"`);

                // Print stats
                console.log('\nIntent prediction errors:');
                let longestIntentLen = Array.from(predictionResult.stats.keys()).concat('TOTAL')
                    .reduce((a, b) => a.length > b.length ? a : b).length;
                let total = 0;
                let totalErrors = 0;
                console.log('  ' + '='.repeat(longestIntentLen + 20));
                predictionResult.stats.forEach((stats, intent) => {
                    total += stats.total;
                    totalErrors += stats.errors;
                    let color = stats.errors > 0 ? colors.red : colors.green;
                    console.log(sprintf(`  %${longestIntentLen}s: ${color('%6.2f%% (%d/%d)')}`,
                        intent, stats.errors / stats.total * 100, stats.errors, stats.total));
                });
                console.log('  ' + '='.repeat(longestIntentLen + 20));
                let color = totalErrors > 0 ? colors.red : colors.green;
                console.log(sprintf(colors.bold(`  %${longestIntentLen}s: ${color('%6.2f%% (%d/%d)')}`),
                    'TOTAL', totalErrors / total * 100, totalErrors, total));

                return predictionResult.errors.length;
            } else {
                console.log('No prediction errors have been found!');
                return 0;
            }
        })
        .catch(handleError);
}

function printError(msg: string) {
    console.error();
    console.error(`  error: ${msg}`);
    console.error();
    process.exit(1);
}

function handleError(err: any) {
    console.error(`ERROR: ${err.message}`);
    if (err.reason) {
        console.error(err.reason);
    }
    process.exit(1);
}
