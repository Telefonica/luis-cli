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

import * as _ from 'lodash';
import { EventEmitter } from 'events';
import { LuisApiClient, LuisApiClientConfig, LuisApi } from './luis-api-client';
import { Luis as LuisModel } from '@telefonica/language-model-converter/lib/luis-model';

const TRAINING_STATUS_POLLING_INTERVAL = 2000;

export interface UpdateEvent {
    create: number;
    delete: number;
}

export type PredictionStats = Map<string, { total: number, errors: number, ambiguities: number }>;

export interface PredictionError {
    text: string;
    tokenizedText?: string[];
    intent: string;
    intentPredictions?: LuisApi.IntentPrediction[];
    ambiguousPredictedIntent?: boolean;
    entities?: (LuisApi.EntityLabelExampleGET | LuisApi.EntityLabelExamplePOST)[];
    predictedEntities?: LuisApi.EntityLabelExamplePOST[];
}

export interface PredictionResult {
    stats: PredictionStats;
    errors: PredictionError[];
}

interface Token {
    token: string;
    startChar: number;
    endChar: number;
}

interface FoundEntity {
    word: string;
    startChar: number;
    endChar: number;
}

export interface LuisTrainerConfig {
    luisApiClientConfig: LuisApiClientConfig;
}

export class LuisTrainer extends EventEmitter {
    private readonly luisApiClient: LuisApiClient;

    constructor(config: LuisTrainerConfig) {
        super();
        this.luisApiClient = new LuisApiClient(config.luisApiClientConfig);
    }

    export(appVersion: string): Promise<LuisModel.Model> {
        return this.luisApiClient.export(appVersion)
            .catch((reason: Error) => {
                let err = new Error('Error trying to export the app') as any;
                err.reason = reason.message;
                return Promise.reject(err);
            });
    }

    update(appVersion: string, model: LuisModel.Model, region?: string, isStaging?: boolean): Promise<void> {
        return this.checkCulture(appVersion, model.culture)
            .then(() => this.updateIntents(appVersion, model.intents.map(
                intent => {
                    return {
                        name: intent.name
                    };
            })))
            .then(() => this.updateEntities(appVersion, model.entities.map(
                entity => {
                    return {
                        name: entity.name
                    };
                }
            )))
            .then(() => this.updatePhraseLists(appVersion, model.model_features))
            .then(() => this.updateExamples(appVersion, model.utterances))
            .then(() => this.train(appVersion))
            .then(() => this.publish(appVersion, region, isStaging))
            .then(() => Promise.resolve());
    }

    /**
     * Check whether the labeled intent and entities for each example match the predicted ones, that is,
     * the recognized intent and entities after being trained the app are the expected ones.
     * We are gathering predictions from the provisioning API that allows us to download all the examples
     * but such an API gives a very low precession for the predicted intent score parameter, which
     * sometimes makes impossible to correctly know the predicted intent because several predicted intents
     * with very close scores will be rounded to 2 decimals and will tie.
     *   Example: intent1's score: 0.87614, intent2's score: 0.87828. Both scores will be rounded to 0.88
     */
    checkPredictions(appVersion: string): Promise<PredictionResult> {
        // Return the top scoring predicted intents. In case of tie, all the top ones will be returned.
        function getTopPredictedIntents(example: LuisApi.ExampleGET): LuisApi.IntentPrediction[] {
            return example.intentPredictions
                .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
                .filter((predictedIntent, i, sortedPredictedIntents) =>
                    predictedIntent.score === sortedPredictedIntents[0].score)
                .map(predictedIntent => {
                    return {
                        name: predictedIntent.name,
                        score: predictedIntent.score
                    };
                });
        }

        function matchPredictedEntities(example: LuisApi.ExampleGET): boolean {
            // Predicted entities must have at least the labeled entities.
            // If there are some extra predicted entities, it is not an issue.
            return _.differenceWith(example.entityLabels, example.entityPredictions, _.isEqual).length === 0;
        }

        function matchTokenizedText(example: LuisApi.ExampleGET): boolean {
            return _.isEqual(example.tokenizedText, LuisTrainer.tokenizeSentence(example.text));
        }

        this.emit('startGetAllExamples');
        this.luisApiClient.on('getExamples', (first: number, last: number) =>
            this.emit('getExamples', first, last));
        return this.luisApiClient.getAllExamples(appVersion)
            .then(examples => {
                this.emit('endGetAllExamples', examples.length);
                // Debug stuff
                // let sortedExamples = examples.sort((a, b) => a.utteranceText.localeCompare(b.utteranceText));
                // sortedExamples = sortedExamples.map(example => {
                //     example.intentPredictions = example.intentPredictions.sort((a, b) => a.name.localeCompare(b.name));
                //     return example;
                // });
                // require('fs').writeFileSync(`all-examples-${new Date().toJSON()}.json`, JSON.stringify(sortedExamples, null, 2), 'utf8');

                let errors = examples
                    // Filter by examples whose labeled intent or entities don't match the predicted ones (or the
                    // matching cannot be established because of a tie).
                    // It also checks the tokenization to ensure our algorithm is working as expected.
                    .map(example => {
                        let error: PredictionError = {
                            text: example.text,
                            intent: example.intentLabel
                        };

                        let topPredictedIntents = getTopPredictedIntents(example);
                        if (topPredictedIntents.findIndex(element => element.name === example.intentLabel) === -1) {
                            // None of the top scoring predicted intents matches the labeled one
                            error.ambiguousPredictedIntent = false;
                            error.intentPredictions = topPredictedIntents;
                        } else if (topPredictedIntents.length > 1) {
                            // The labeled intent is one of the top scoring predicted ones
                            // but they all share the same score
                            error.ambiguousPredictedIntent = true;
                            error.intentPredictions = topPredictedIntents;
                        } else {
                            // The labeled intent matches the only one top scoring predicted intent
                        }

                        if (!matchPredictedEntities(example)) {
                            error.entities = example.entityLabels;
                            error.predictedEntities = example.entityPredictions.map(
                                entityPrediction => {
                                    return {
                                        entityName: entityPrediction.entityName,
                                        startCharIndex: entityPrediction.startIndex,
                                        endCharIndex: entityPrediction.endIndex
                                    };
                                }
                            );
                        }

                        if (!matchTokenizedText(example)) {
                            error.tokenizedText = example.tokenizedText;
                        }

                        if (error.intentPredictions || error.predictedEntities || error.tokenizedText) {
                            return error;
                        } else {
                            return null;
                        }
                    })
                    .filter(example => example !== null);

                // Calculate stats
                let exampleCounter = _.countBy(examples, example => example.intentLabel);
                let intentErrorCounter = _.countBy(
                    errors.filter(error => error.intentPredictions && !error.ambiguousPredictedIntent),
                    error => error.intent);
                let ambiguousIntentCounter = _.countBy(
                    errors.filter(error => error.intentPredictions && error.ambiguousPredictedIntent),
                    error => error.intent);
                let stats: PredictionStats = new Map();
                _.forEach(exampleCounter, (counter, intent) => {
                    stats.set(intent, {
                        total: counter,
                        errors: intentErrorCounter[intent] || 0,
                        ambiguities: ambiguousIntentCounter[intent] || 0
                    });
                });

                return {
                    stats,
                    errors
                } as PredictionResult;
            });

    }

    /**
     * Send a set of examples to be recognized by the application to verify that the expected intent
     * and entities match the labeled one.
     */
    testExamples(examples: LuisModel.Utterance[]): Promise<PredictionResult> {
        function matchRecognizedEntities(
            labeledEntities: LuisApi.EntityLabelExamplePOST[],
            recognizedEntities: LuisApi.RecognizedEntity[]): boolean {
            // Recognized entities must have at least the labeled entities.
            // If there are some extra recognized entities, it is not an issue.
            return _.differenceWith<any>(labeledEntities, recognizedEntities,
                (labeled: LuisApi.EntityLabelExamplePOST, recognized: LuisApi.RecognizedEntity) =>
                    labeled.entityName === recognized.entity &&
                    labeled.startCharIndex === recognized.startIndex &&
                    labeled.endCharIndex === recognized.endIndex
            ).length === 0;
        }

        this.luisApiClient.on('recognizeSentence', (sentence: string) =>
            this.emit('recognizeSentence', sentence));

        return this.luisApiClient.recognizeSentences(examples.map(example => example.text))
            .then(recognitionResults => {
                let errors = recognitionResults
                    // Filter by examples whose labeled intent or entities don't match the predicted ones.
                    .map((recognitionResult, i) => {
                        let example = examples[i];
                        let error: PredictionError = {
                            text: example.text,
                            intent: example.intent
                        };

                        // Compare intents
                        if (example.intent !== recognitionResult.topScoringIntent.intent) {
                            error.ambiguousPredictedIntent = false;
                            error.intentPredictions = [
                                {
                                    name: recognitionResult.topScoringIntent.intent,
                                    score: recognitionResult.topScoringIntent.score
                                }
                            ];
                        }

                        // Compare entities
                        let labeledEntities = example.entities.map(entity => {
                            let foundEntity = LuisTrainer.findEntity(example.text, entity.startPos, entity.endPos);
                            return {
                                entityName: foundEntity.word,
                                startCharIndex: foundEntity.startChar,
                                endCharIndex: foundEntity.endChar
                            };
                        });
                        if (!matchRecognizedEntities(labeledEntities, recognitionResult.entities)) {
                            error.entities = labeledEntities;
                            error.predictedEntities = recognitionResult.entities.map(entity => {
                                return {
                                    entityName: entity.entity,
                                    startCharIndex: entity.startIndex,
                                    endCharIndex: entity.endIndex
                                };
                            });
                        }

                        if (error.intentPredictions || error.predictedEntities) {
                            return error;
                        } else {
                            return null;
                        }
                    })
                    .filter(example => example !== null);

                // Calculate stats
                let exampleCounter = _.countBy(examples, example => example.intent);
                let intentErrorCounter = _.countBy(errors.filter(error => error.intentPredictions), error => error.intent);
                let stats: PredictionStats = new Map();
                _.forEach(exampleCounter, (counter, intent) => {
                    stats.set(intent, {
                        total: counter,
                        errors: intentErrorCounter[intent] || 0,
                        ambiguities: 0
                    });
                });

                return {
                    stats,
                    errors
                } as PredictionResult;
            });
    }

    private static wrapError(error: Error, message: string) {
        if (error.name === 'OwnError') {
            return Promise.reject(error);
        }
        let err = new Error(message) as any;
        err.reason = error.message;
        return Promise.reject(err);
    }

    private checkCulture(appVersion: string, culture: string): Promise<void> {
        return this.luisApiClient.getApp()
            .then(appInfo => {
                if (appInfo.culture === culture) {
                    return Promise.resolve();
                } else {
                    let err = new Error(`The model culture (${culture}) doesn't match ` +
                        `the target application culture (${appInfo.culture})`);
                    err.name = 'OwnError';
                    throw err;
                }
            })
            .catch(err => LuisTrainer.wrapError(err, 'Error trying to check the culture'));
    }

    private updateIntents(appVersion: string, intents: LuisApi.IntentPOST[]): Promise<void> {
        return this.luisApiClient.getIntents(appVersion)
            .then(oldIntents => {
                let intentsToBeDeleted = _.differenceWith<any>(oldIntents, intents,
                    (a: LuisApi.IntentGET, b: LuisApi.IntentPOST) => a.name === b.name);
                let intentsToBeCreated = _.differenceWith<LuisApi.IntentPOST>(intents, oldIntents,
                    (a: LuisApi.IntentPOST, b: LuisApi.IntentGET) => a.name === b.name
                );
                let stats: UpdateEvent = {
                    create: intentsToBeCreated.length,
                    delete: intentsToBeDeleted.length
                };
                this.emit('startUpdateIntents', stats);
                return this.luisApiClient.deleteIntents(appVersion, intentsToBeDeleted)
                    .then(() => this.luisApiClient.createIntents(appVersion, intentsToBeCreated))
                    .then(() => {
                        this.emit('endUpdateIntents', stats);
                    });
            })
            .catch(err => LuisTrainer.wrapError(err, 'Error trying to update intents'));
    }

    private updateEntities(appVersion: string, entities: LuisApi.EntityPOST[]): Promise<void> {
        return this.luisApiClient.getEntities(appVersion)
            .then(oldEntities => {
                let entitiesToBeDeleted = _.differenceWith<any>(
                    oldEntities, entities,
                    (a: LuisApi.EntityGET, b: LuisApi.EntityPOST) => a.name === b.name);
                let entitiesToBeCreated = _.differenceWith<LuisApi.EntityPOST>(entities, oldEntities,
                    (a: LuisApi.EntityPOST, b: LuisApi.EntityGET) => a.name === b.name
                );
                let stats: UpdateEvent = {
                    create: entitiesToBeCreated.length,
                    delete: entitiesToBeDeleted.length
                };
                this.emit('startUpdateEntities', stats);
                return this.luisApiClient.deleteEntities(appVersion, entitiesToBeDeleted)
                    .then(() => this.luisApiClient.createEntities(appVersion, entitiesToBeCreated))
                    .then(() => {
                        this.emit('endUpdateEntities', stats);
                    });
            })
            .catch(err => LuisTrainer.wrapError(err, 'Error trying to update entities'));
    }

    private updatePhraseLists(appVersion: string, modelPhraseLists: LuisModel.ModelFeature[]): Promise<void> {
        /**
         * Compare phraseLists ignoring non-meaningful properties
         */
        const comparePhraseLists = (a: any, b: any) => {
            return a.name === b.name &&
                a.isActive === b.isActive &&
                a.isExchangeable === b.isExchangeable &&
                a.phrases === b.phrases;
        };

        return this.luisApiClient.getPhraseLists(appVersion)
            .then(oldPhraseLists => {
                // Convert data from the model to the format used by the API
                let phraseLists = modelPhraseLists.map((phraseList: LuisModel.ModelFeature) => {
                    return {
                        name: phraseList.name,
                        isActive: phraseList.activated,
                        isExchangeable: true,
                        phrases: phraseList.words
                    } as LuisApi.PhraseListPOST;
                });
                let phraseListsToBeDeleted = _.differenceWith<any>(oldPhraseLists, phraseLists, comparePhraseLists);
                let phraseListToBeCreated = _.differenceWith<LuisApi.PhraseListPOST>(phraseLists, oldPhraseLists, comparePhraseLists);
                let stats: UpdateEvent = {
                    create: phraseListToBeCreated.length,
                    delete: phraseListsToBeDeleted.length
                };
                this.emit('startUpdatePhraseLists', stats);
                return this.luisApiClient.deletePhraseLists(appVersion, phraseListsToBeDeleted)
                    .then(() => this.luisApiClient.createPhraseLists(appVersion, phraseListToBeCreated))
                    .then(() => {
                        this.emit('endUpdatePhraseLists', stats);
                    });
            })
            .catch(err => LuisTrainer.wrapError(err, 'Error trying to update phrase lists'));
    }

    private updateExamples(appVersion: string, modelExamples: LuisModel.Utterance[]): Promise<void> {
        this.emit('startGetAllExamples');
        this.luisApiClient.on('getExamples', (first: number, last: number) =>
            this.emit('getExamples', first, last));
        return this.luisApiClient.getAllExamples(appVersion)
            .then(oldExamples => {
                this.emit('endGetAllExamples', oldExamples.length);
                // Examples to be deleted will be those whose texts are no longer needed.
                // It could happen that some examples share texts but have different intent or entities
                // but those will be overwritten when uploading the so called `examplesToBeCreated`.
                let examplesToBeDeleted = _.differenceWith<any>(oldExamples, modelExamples,
                    (a: LuisApi.ExampleGET, b: LuisModel.Utterance) => a.text === b.text);

                // Examples to be uploaded (overwriting those that already exist with the same text although
                // they have different intents or entities) will be those that don't already exist or
                // differs from existing one by the intent or entities.
                let examplesToBeCreated = _.differenceWith<any>(modelExamples, oldExamples,
                    (a: LuisModel.Utterance, b: LuisApi.ExampleGET) => {
                        let eq = a.text === b.text &&
                            a.intent === b.intentLabel &&
                            a.entities.length === b.entityLabels.length &&
                            // Compare array of entities w/o assuming the same order
                            a.entities.length === _.intersectionWith<any>(a.entities, b.entityLabels,
                                (ae: LuisModel.EntityPosition, be: LuisApi.EntityLabelExamplePOST) =>
                                    ae.entity === be.entityName && ae.startPos === be.startCharIndex && ae.endPos === be.endCharIndex
                            ).length;
                        return eq;
                    }
                )
                // Convert data from the model to the format used by the API
                .map((example: LuisModel.Utterance) => {
                    let entityLabels = example.entities.map(entity => {
                        let foundEntity = LuisTrainer.findEntity(example.text, entity.startPos, entity.endPos);
                        return {
                            entityName: entity.entity,
                            startCharIndex: foundEntity.startChar,
                            endCharIndex: foundEntity.endChar
                        };
                    });
                    entityLabels = (entityLabels.length === 0) ? null : entityLabels;
                    return {
                        text: example.text,
                        intentName: example.intent,
                        entityLabels: entityLabels
                    } as LuisApi.ExamplePOST;
                });

                // Debug stuff for hunting examples that are recurrently created even when theoretically they already exist
                // Won't be removed until we are completely sure that everything is going well
                // require('fs').writeFileSync('old.txt', oldExamples.map(example => example.utteranceText).sort().join('\n'), 'utf-8');
                // require('fs').writeFileSync('create.txt', examplesToBeCreated.map(example =>
                //   example.exampleText).sort().join('\n'), 'utf-8');
                // let SENTENCE = '';
                // console.log('='.repeat(50));
                // console.log(newExamples.filter(example => example.text === SENTENCE));
                // console.log('='.repeat(50));
                // console.log(oldExamples.filter(example => example.utteranceText === SENTENCE));
                // console.log('='.repeat(50));
                // console.log(examplesToBeCreated.filter(example => example.exampleText === SENTENCE));
                // console.log('='.repeat(50));

                let stats: UpdateEvent = {
                    create: examplesToBeCreated.length,
                    delete: examplesToBeDeleted.length
                };
                this.emit('startUpdateExamples', stats);
                this.luisApiClient.on('deleteExample', (exampleId: string) =>
                    this.emit('deleteExample', exampleId));
                this.luisApiClient.on('createExampleBunch', (bunchLength: number) =>
                    this.emit('createExampleBunch', bunchLength));
                return this.luisApiClient.deleteExamples(appVersion, examplesToBeDeleted)
                    .then(() => this.luisApiClient.createExamples(appVersion, examplesToBeCreated))
                    .then(() => {
                        this.emit('endUpdateExamples', stats);
                    });
            })
            .catch(err => LuisTrainer.wrapError(err, 'Error trying to update examples'));
    }

    private train(appVersion: string): Promise<void> {
        const delay = (t: number): Promise<void> => {
            return new Promise<void>(resolve => {
                setTimeout(resolve, t);
            });
        };

        const waitForTraining = (): Promise<void> => {
            return delay(TRAINING_STATUS_POLLING_INTERVAL)
                .then(() => this.luisApiClient.getTrainingStatus(appVersion))
                .then((trainingStatus: LuisApi.TrainingStatus) => {
                    // Debug stuff
                    // console.log(trainingStatus.map(ts => ts.status).join(''));
                    let finishedModels = trainingStatus.filter(modelStatus =>
                        // The training has finished when the status is "Success", "Up to date" or "Failed".
                        modelStatus.status === LuisApi.TrainingStatuses.Success ||
                        modelStatus.status === LuisApi.TrainingStatuses.UpToDate ||
                        modelStatus.status === LuisApi.TrainingStatuses.Fail);
                    this.emit('trainingProgress', finishedModels.length, trainingStatus.length);
                    if (finishedModels.length < trainingStatus.length) {
                        return waitForTraining();
                    }
                    // Look for failures
                    let failedModels = trainingStatus
                        .filter(modelStatus => modelStatus.status === LuisApi.TrainingStatuses.Fail);
                    if (failedModels.length) {
                        let err = new Error(
                            `${failedModels.length} model(s) have failed with the following reasons:\n` +
                            failedModels.map(model => `${model.modelId}: ${model.failureReason}`).join('\n')
                        );
                        err.name = 'OwnError';
                        throw err;
                    } else {
                        this.emit('endTraining');
                        return Promise.resolve();
                    }
                });
        };

        this.emit('startTraining');
        return this.luisApiClient.startTraining(appVersion)
            .then((trainingStatus) => {
                // Debug stuff
                // console.log(trainingStatus.map(ts => ts.status).join(''));
                return waitForTraining();
            })
            // TODO: Catch the error when there already is a training ongoing to wait for it
            .catch(err => LuisTrainer.wrapError(err, 'Error trying to train models'));
    }

    private publish(appVersion: string, region?: string, isStaging?: boolean): Promise<void> {
        this.emit('startPublish');
        return this.luisApiClient.publish(appVersion, region, isStaging)
            .then(publishResult => {
                this.emit('endPublish');
            })
            .catch(err => LuisTrainer.wrapError(err, 'Error trying to publish the app'));
    }

    /**
     * Tokenize a sentence following the LUIS rules returning the tokens and delimiters.
     * TODO: Memoize this function.
     */
    private static splitSentenceByTokens(sentence: string): Token[] {
        if (!sentence || sentence.trim().length === 0) {
            return [];
        }
        sentence = sentence.replace(/[\s\uFEFF\xA0]+$/g, '');  // Right trim

        // The following is a RegExp that contains the UTF-8 characters (http://www.utf8-chartable.de/unicode-utf8-table.pl)
        // that are understood by LUIS as part of a word. Chars not included here
        // are considered as separated words by LUIS and so as independent tokens
        const WORD_CHARS =
            '0-9A-Za-z' +  // Numbers and English letters
            'ªº' +  // Ordinal indicators
            '\u00B5' +  // Micro sign
            '\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02AF' +  // Non-english latin letters (accents and others)
            '\u02B0-\u02C1' +  // Modifier letters
            '\u0370-\u0374\u0376-\u0377\u037A-\u037D\u0386\u0388-\u038A\u038C\u038E-\u03A1\u03A3-\u03FF' + // Greek and Coptic alphabets
            '\u0400-\u0481\u048A-\u0523'  // Cyrillic alphabet
            // Leaving the remaining alphabets for another brave person
        ;
        // A word is any number > 0 of WORD_CHARS
        const WORD = new RegExp(`^[${WORD_CHARS}]+`);
        // A non-word is any character not in WORD_CHARS and not a space
        const NON_WORD = new RegExp(`^[^\s${WORD_CHARS}]`);

        let tokens: Token[] = [];

        // Walk through the sentence consuming chunks that matches WORD or NON_WORD
        let sentenceIndex = 0;
        while (sentence.length) {
            // Ignore spaces at the beginning of the remaining sentence
            let leadingSpaces = sentence.match(/^\s*/)[0].length;
            // Consume the spaces
            sentenceIndex += leadingSpaces;
            sentence = sentence.slice(leadingSpaces);

            // Try a word
            let tokenRegExpRes = sentence.match(WORD);
            if (!tokenRegExpRes) {
                // If not a word, try a non-word
                tokenRegExpRes = sentence.match(NON_WORD);
            }
            if (!tokenRegExpRes) {
                // If not word nor non-word... It should be impossible
                throw new Error(`The sentence ${sentence} cannot be classified as word or non-word`);
            }

            let token = tokenRegExpRes[0];
            tokens.push({
                token: token,
                startChar: sentenceIndex,
                endChar: sentenceIndex + token.length - 1
            });
            // Consume the recognized token
            sentenceIndex += token.length;
            sentence = sentence.slice(token.length);
        }

        return tokens;
    }

    /**
     * Tokenize a sentence following the LUIS rules and return an array of strings
     */
    private static tokenizeSentence(sentence: string): string[] {
        return LuisTrainer.splitSentenceByTokens(sentence).map(token => token.token);
    }

    /**
     * Find the entity text inside the sentence from its start and end positions.
     */
    private static findEntity(sentence: string, startPos: number, endPos: number): FoundEntity {
        let tokens = LuisTrainer.splitSentenceByTokens(sentence);

        if (startPos < 0 || startPos >= tokens.length || endPos < 0 || endPos >= tokens.length) {
            throw new Error('Entity positions are out of range');
        }
        let startChar = tokens[startPos].startChar;
        let endChar = tokens[endPos].endChar;
        let word = sentence.slice(startChar, endChar + 1);
        return {
            word,
            startChar,
            endChar
        } as FoundEntity;
    }

}
