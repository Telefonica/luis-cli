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
import { LuisTrainer, LuisTrainerConfig, UpdateEvent, PredictionResult } from './luis-trainer';
import { Luis as LuisModel } from '@telefonica/language-model-converter/lib/luis-model';


const DEFAULT_LUIS_ENDPOINT = 'https://westus.api.cognitive.microsoft.com';

enum Commands { Update, Export, CheckPredictions, TestExamples };
let command: Commands;

let runner: Promise<number> = null;

interface ProgramOptions extends commander.ICommand {
    parent?: ProgramOptions;  // When using commands, `parent` holds options from the main program
    endpoint?: string;
    applicationId?: string;
    model?: string;
    errors?: string;
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
    .option('-m, --model <filename>', 'JSON file containing the model to upload to the LUIS application')
    .action(options => selectRunner(Commands.Update, options))
    .on('--help', function() {
        console.log('  Example:');
        console.log();
        console.log(`    Update an application using the model from the file 'model.json':`);
        console.log('      $ luis-cli update -a XXX -m model.json -s YYY');
    });

program
    .command('export')
    .description('Export a LUIS application to the given <filename>')
    .option('-a, --application-id <application-id>', 'LUIS application id (also got from the LUIS_APPLICATION_ID env var)')
    .option('-m, --model <filename>', 'file where the LUIS application will be exported to')
    .action(options => selectRunner(Commands.Export, options))
    .on('--help', function() {
        console.log('  Example:');
        console.log();
        console.log(`    Export an application to the file 'model.json':`);
        console.log('      $ luis-cli export -a XXX -m model.json -s YYY');
    });

program
    .command('check')
    .description(`Check a trained LUIS application to verify whether each example's intent and entities match the predicted ones`)
    .option('-a, --application-id <application-id>', 'LUIS application id (also got from the LUIS_APPLICATION_ID env var)')
    .option('-r, --errors <filename>', `JSON file where prediction errors will be stored`)
    .action(options => selectRunner(Commands.CheckPredictions, options))
    .on('--help', function() {
        console.log('  Example:');
        console.log();
        console.log(`    Check whether an application correctly predict intents and entities and save differences to 'errors.json':`);
        console.log('      $ luis-cli check -a XXX -r errors.json -s YYY');
    });

program
    .command('test')
    .description(`Test a set of examples against a trained application to verify the correct recognition of intents and entities`)
    .option('-a, --application-id <application-id>', 'LUIS application id (also got from the LUIS_APPLICATION_ID env var)')
    .option('-m, --model <filename>', 'JSON file containing the model whose examples will be used to test the LUIS application')
    .option('-r, --errors <filename>', `JSON file where prediction errors will be stored`)
    .action(options => selectRunner(Commands.TestExamples, options))
    .on('--help', function() {
        console.log('  Example:');
        console.log();
        console.log(`    Check whether a set of examples are correctly recognized by an application in terms of intent and entities and save differences to 'errors.json':`);
        console.log('      $ luis-cli check -m model.json -a XXX -f errors.json -s YYY');
    });

program.parse(process.argv);

if (!runner) {
    // No command has been selected
    printError('supported commands: update, export, check, test');
}

runner.then((exitCode: number) => {
    process.exit(exitCode || 0);
});


function selectRunner(command: Commands, options: ProgramOptions) {
    // Get values from env vars if not provided via options
    let endpoint = options.parent.endpoint || process.env.LUIS_ENDPOINT;
    let subscriptionKey = options.parent.subscriptionKey || process.env.LUIS_SUBSCRIPTION_KEY;
    let applicationId = options.applicationId || process.env.LUIS_APPLICATION_ID;

    // Check mandatory options
    if (!subscriptionKey) {
        printError('unknown LUIS subscription key. Provide one through the `-s, --subscription-key` option ' +
            'or the `LUIS_SUBSCRIPTION_KEY` env var.');
    }
    if ((command === Commands.Update || command === Commands.Export || command === Commands.CheckPredictions ||
         command === Commands.TestExamples) && !applicationId) {
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
            if (!options.model) {
                printError('missing JSON file from which the model will be read. Provide one through the `-m, --model` option.');
            }
            runner = updateApp(luisTrainer, applicationId, options.model);
            break;

        case Commands.Export:
            if (!options.model) {
                printError('missing JSON file to which the application will be exported. Provide one through the `-m, --model` option.');
            }
            runner = exportApp(luisTrainer, applicationId, options.model);
            break;

        case Commands.CheckPredictions:
            if (!options.errors) {
                printError('missing JSON file to which the differences will be saved. Provide one through the `-r, --errors` option.');
            }
            runner = checkPrediction(luisTrainer, applicationId, options.errors);
            break;

        case Commands.TestExamples:
            if (!options.model) {
                printError('missing JSON file from which the examples will be read. Provide one through the `-m, --model` option.');
            }
            if (!options.errors) {
                printError('missing JSON file to which the differences will be saved. Provide one through the `-r, --errors` option.');
            }
            runner = testExamples(luisTrainer, applicationId, options.model, options.errors);
            break;
    }
}

function updateApp(luisTrainer: LuisTrainer, applicationId: string, modelFilename: string): Promise<number> {
    let model: LuisModel.Model;
    try {
        model = JSON.parse(fs.readFileSync(modelFilename, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') {
            printError(`the file ${modelFilename} does not exist.`);
        } else {
            handleError(err);
        }
    }

    console.log(`Updating the application ${applicationId} with the model from "${modelFilename}"...`);
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

function exportApp(luisTrainer: LuisTrainer, applicationId: string, modelFilename: string): Promise<number> {
    console.log(`Exporting the application ${applicationId} to "${modelFilename}"...`);
    return luisTrainer.export()
        .then(model => {
            fs.writeFileSync(modelFilename, JSON.stringify(model, null, 2));
            console.log(`The application has been exported to "${modelFilename}"`);
            return 0;
        })
        .catch(handleError);
}

function checkPrediction(luisTrainer: LuisTrainer, applicationId: string, errorsFilename: string): Promise<number> {
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
                processPredictionResult(predictionResult, errorsFilename);
                return predictionResult.errors.length;
            } else {
                console.log('No prediction errors have been found!');
                return 0;
            }
        })
        .catch(handleError);
}

function testExamples(luisTrainer: LuisTrainer, applicationId: string, modelFilename: string, errorsFilename: string): Promise<number> {
    let model: LuisModel.Model;
    try {
        model = JSON.parse(fs.readFileSync(modelFilename, 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') {
            printError(`the file ${modelFilename} does not exist.`);
        } else {
            handleError(err);
        }
    }

    console.log(`Testing ${model.utterances.length} examples from "${modelFilename}" against the application ${applicationId}...`);

    let recognized = 0;
    luisTrainer.on('recognizeSentence', (sentence: string) => {
        recognized++;
        process.stdout.write(`\rRecognized ${recognized}/${model.utterances.length} sentences ` +
            `(${(recognized / model.utterances.length * 100).toFixed(0)}%)`);
        if (recognized >= model.utterances.length) {
            console.log();
        }
    });

    return luisTrainer.testExamples(model.utterances)
        .then(predictionResult => {
            if (predictionResult.errors.length) {
                processPredictionResult(predictionResult, errorsFilename);
                return predictionResult.errors.length;
            } else {
                console.log('No recognition errors have been found!');
                return 0;
            }
        })
        .catch(handleError);
}

function processPredictionResult(predictionResult: PredictionResult, errorsFilename: string) {
    // Print a summary of errors
    let intentErrors = predictionResult.errors.filter(error =>
        error.predictedIntents && !error.ambiguousPredictedIntent).length;
    let ambiguousIntentErrors = predictionResult.errors.filter(error =>
        error.predictedIntents && error.ambiguousPredictedIntent).length;
    let entityErrors = predictionResult.errors.filter(error => error.predictedEntities).length;
    let tokenizationErrors = predictionResult.errors.filter(error => error.tokenizedText).length;
    console.log('\nThe following prediction errors have been found:');
    if (intentErrors) {
        console.log(`  - ${colors.bold(intentErrors.toString())} examples whose predicted intent is wrong.`);
    }
    if (ambiguousIntentErrors) {
        console.log(`  - ${colors.bold(ambiguousIntentErrors.toString())} examples who has more than one ` +
            `predicted intent that match the labeled one`);
    }
    if (entityErrors) {
        console.log(`  - ${colors.bold(entityErrors.toString())} examples whose predicted entities are wrong.`);
    }
    if (tokenizationErrors) {
        console.log(`  - ${colors.bold(tokenizationErrors.toString())} examples have been incorrectly tokenized.`);
    }

    // Write the error details to the file
    let sortedErrors = predictionResult.errors.sort((a, b) => a.intent.localeCompare(b.intent));
    fs.writeFileSync(errorsFilename, JSON.stringify(sortedErrors, null, 2));
    console.log(`\nAll the prediction errors have been saved in "${errorsFilename}"`);

    // Print intent stats
    console.log(`\n\n  ${colors.bold('INTENT PREDICTION ERRORS')}\n`);

    const HEADERS = {COL1: 'INTENTS', COL2: 'ERRORS', COL3: 'AMBIGUITIES'};
    let longestIntentLen = 0;
    let total = 0;
    let totalErrors = 0;
    let totalAmbiguities = 0;

    let strStats: {intent: string, errors: string, ambiguities: string, color: Function}[] = [];
    let sortedStats = new Map([...predictionResult.stats.entries()].sort());
    sortedStats.forEach((stats, intent) => {
        if (intent.length > longestIntentLen) {
            longestIntentLen = intent.length;
        }
        total += stats.total;
        totalErrors += stats.errors;
        totalAmbiguities += stats.ambiguities;
        strStats.push({
            intent,
            errors: sprintf('%6.2f%% (%d/%d)', stats.errors / stats.total * 100, stats.errors, stats.total),
            ambiguities: sprintf('%6.2f%% (%d/%d)', stats.ambiguities / stats.total * 100, stats.ambiguities, stats.total),
            color: stats.errors > 0 ? colors.red : stats.ambiguities > 0 ? colors.blue : colors.green
        });
    });

    let strTotalErrors = sprintf('%6.2f%% (%d/%d)', totalErrors / total * 100, totalErrors, total);
    let strTotalAmbiguities = sprintf('%6.2f%% (%d/%d)', totalAmbiguities / total * 100, totalAmbiguities, total);
    let color = totalErrors > 0 ? colors.red : totalAmbiguities > 0 ? colors.blue : colors.green;

    let col1Len = Math.max(HEADERS.COL1.length, longestIntentLen);
    let col2Len = Math.max(HEADERS.COL2.length, strTotalErrors.length);
    let col3Len = Math.max(HEADERS.COL3.length, strTotalAmbiguities.length);
    console.log('  ' + colors.bold(sprintf(`%${col1Len}s  %-${col2Len}s  %-${col3Len}s`,
        HEADERS.COL1, HEADERS.COL2, HEADERS.COL3)));
    console.log('  ' + '='.repeat(col1Len + 2 + col2Len + 2 + col3Len + 1));
    strStats.forEach(line => {
        console.log('  ' + sprintf(`%${col1Len}s  ${line.color(`%-${col2Len}s  %-${col3Len}s`)}`,
            line.intent, line.errors, line.ambiguities));
    });
    console.log('  ' + '='.repeat(col1Len + 2 + col2Len + 2 + col3Len + 1));
    console.log('  ' + colors.bold(sprintf(`%${col1Len}s  ${color(`%-${col2Len}s  %-${col3Len}s`)}`,
        'TOTAL', color(strTotalErrors), color(strTotalAmbiguities))));

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
