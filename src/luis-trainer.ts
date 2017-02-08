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

interface RecognizedEntity {
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

    export(): Promise<LuisModel.Model> {
        return this.luisApiClient.export()
            .catch((reason: Error) => {
                let err = new Error('Error trying to export the app') as any;
                err.reason = reason.message;
                return Promise.reject(err);
            });
    }

    update(model: LuisModel.Model): Promise<void> {
        return this.checkCulture(model.culture)
            .then(() => this.updateIntents(model.intents.map(intent => intent.name)))
            .then(() => this.updateEntities(model.entities.map(entity => entity.name)))
            .then(() => this.updatePhraseLists(model.model_features))
            .then(() => this.updateExamples(model.utterances))
            .then(() => this.train())
            .then(() => this.publish())
            .then(() => Promise.resolve());
    }

    private wrapError(error: Error, message: string) {
        if (error.name === 'OwnError') {
            return Promise.reject(error);
        }
        let err = new Error(message) as any;
        err.reason = error.message;
        return Promise.reject(err);
    }

    private checkCulture(culture: string): Promise<void> {
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
            .catch(err => this.wrapError(err, 'Error trying to check the culture'));
    }

    private updateIntents(newIntents: string[]): Promise<void> {
        return this.luisApiClient.getIntents()
            .then(oldIntents => {
                let intentIdsToBeDeleted = _.differenceWith(oldIntents, newIntents,
                    (a: LuisApi.IntentClassifier, b: string) => a.name === b
                ).map(intent => intent.id);
                let intentsToBeCreated = _.differenceWith(newIntents, oldIntents,
                    (a: string, b: LuisApi.IntentClassifier) => a === b.name
                );
                let stats: UpdateEvent = {
                    create: intentsToBeCreated.length,
                    delete: intentIdsToBeDeleted.length
                };
                this.emit('startUpdateIntents', stats);
                return this.luisApiClient.deleteIntents(intentIdsToBeDeleted)
                    .then(() => this.luisApiClient.createIntents(intentsToBeCreated))
                    .then(() => {
                        this.emit('endUpdateIntents', stats);
                    });
            })
            .catch(err => this.wrapError(err, 'Error trying to update intents'));
    }

    private updateEntities(newEntities: string[]): Promise<void> {
        return this.luisApiClient.getEntities()
            .then(oldEntities => {
                let entityIdsToBeDeleted = _.differenceWith(oldEntities, newEntities,
                    (a: LuisApi.EntityExtractor, b: string) => a.name === b
                ).map(entity => entity.id);
                let entitiesToBeCreated = _.differenceWith(newEntities, oldEntities,
                    (a: string, b: LuisApi.EntityExtractor) => a === b.name
                );
                let stats: UpdateEvent = {
                    create: entitiesToBeCreated.length,
                    delete: entityIdsToBeDeleted.length
                };
                this.emit('startUpdateEntities', stats);
                return this.luisApiClient.deleteEntities(entityIdsToBeDeleted)
                    .then(() => this.luisApiClient.createEntities(entitiesToBeCreated))
                    .then(() => {
                        this.emit('endUpdateEntities', stats);
                    });
            })
            .catch(err => this.wrapError(err, 'Error trying to update entities'));
    }

    private updatePhraseLists(newPhraseLists: LuisModel.ModelFeature[]): Promise<void> {
        return this.luisApiClient.getPhraseLists()
            .then(oldPhraseLists => {
                let phraseListIdsToBeDeleted = _.differenceWith(oldPhraseLists, newPhraseLists,
                    (a: LuisApi.PhraseList, b: LuisModel.ModelFeature) => a.name === b.name
                ).map(phraseList => phraseList.id);
                let phraseListToBeCreated = _.differenceWith(newPhraseLists, oldPhraseLists,
                    (a: LuisModel.ModelFeature, b: LuisApi.PhraseList) => a.name === b.name
                )
                // Convert data from the model to the format used by the API
                .map((phraseList: LuisModel.ModelFeature) => {
                    return {
                        name: phraseList.name,
                        mode: phraseList.mode === false ?
                            LuisApi.PhraseListModes.NonExchangeable : LuisApi.PhraseListModes.Exchangeable,
                        phrases: phraseList.words
                    } as LuisApi.PhraseList;
                });
                let stats: UpdateEvent = {
                    create: phraseListToBeCreated.length,
                    delete: phraseListIdsToBeDeleted.length
                };
                this.emit('startUpdatePhraseLists', stats);
                return this.luisApiClient.deletePhraseLists(phraseListIdsToBeDeleted)
                    .then(() => this.luisApiClient.createPhraseLists(phraseListToBeCreated))
                    .then(() => {
                        this.emit('endUpdatePhraseLists', stats);
                    });
            })
            .catch(err => this.wrapError(err, 'Error trying to update phrase lists'));
    }

    private updateExamples(newExamples: LuisModel.Utterance[]): Promise<void> {
        this.emit('startGetAllExamples');
        this.luisApiClient.on('getExamples', (first: number, last: number) =>
            this.emit('getExamples', first, last));
        return this.luisApiClient.getAllExamples()
            .then(oldExamples => {
                this.emit('endGetAllExamples', oldExamples.length);
                let exampleIdsToBeDeleted = _.differenceWith(oldExamples, newExamples,
                    (a: LuisApi.LabeledUtterance, b: LuisModel.Utterance) => a.utteranceText === b.text
                ).map(example => example.id);
                /* I will come back to this later in order to optimize the number examples to create
                   discarding those ones that have not changed (usually most of the examples won't change)
                let examplesToBeCreated = _.differenceWith(newExamples, oldExamples,
                    (a: LuisModel.Utterance, b: LuisApiClient.LabeledUtterance) => {
                        // Convert `a` to a LuisApiClient.LabeledUtterance to make easier the comparison
                        let c: LuisApiClient.LabeledUtterance = {
                            id: null,
                            utteranceText: a.text,
                            intent: a.intent,
                            entities: a.entities.map(ae => {
                                let recognizedEntity = this.recognizeEntity(a.text, ae.startPos, ae.endPos);
                                return {
                                    name: ae.entity,
                                    startToken: recognizedEntity.startChar,
                                    endToken: recognizedEntity.endChar,
                                    word: recognizedEntity.word,
                                    isBuiltInExtractor: false
                                } as LuisApiClient.LabeledEntity;
                            }).sort((a, b) => b.startToken - a.startToken || b.endToken - a.endToken)
                        };

                    }
                );
                */
                // Convert data from the model to the format used by the API
                let examplesToBeCreated = newExamples.map(example => {
                    return {
                        exampleText: example.text,
                        selectedIntentName: example.intent,
                        entityLabels: example.entities.map(entity => {
                            let recognizedEntity = this.recognizeEntity(example.text, entity.startPos, entity.endPos);
                            return {
                                entityType: entity.entity,
                                startToken: recognizedEntity.startChar,
                                endToken: recognizedEntity.endChar
                            } as LuisApi.Entity;
                        })
                    } as LuisApi.Example;
                });

                let stats: UpdateEvent = {
                    create: examplesToBeCreated.length,
                    delete: exampleIdsToBeDeleted.length
                };
                this.emit('startUpdateExamples', stats);
                this.luisApiClient.on('deleteExample', (exampleId: string) =>
                    this.emit('deleteExample', exampleId));
                this.luisApiClient.on('createExampleBunch', (bunchLength: number) =>
                    this.emit('createExampleBunch', bunchLength));
                return this.luisApiClient.deleteExamples(exampleIdsToBeDeleted)
                    .then(() => this.luisApiClient.createExamples(examplesToBeCreated))
                    .then(() => {
                        this.emit('endUpdateExamples', stats);
                    });
            })
            .catch(err => this.wrapError(err, 'Error trying to update examples'));
    }

    private train(): Promise<void> {
        const delay = (t: number): Promise<void> => {
            return new Promise<void>(resolve => {
                setTimeout(resolve, t);
            });
        };

        const waitForTraining = (): Promise<void> => {
            return delay(TRAINING_STATUS_POLLING_INTERVAL)
                .then(() => this.luisApiClient.getTrainingStatus())
                .then((trainingStatus: LuisApi.TrainingStatus) => {
                    let finishedModels = trainingStatus.filter(modelStatus =>
                        // The training has finished when the status is "Up to date" or when there is a failure.
                        // Probably there is a status that signal a failure but due to the lack of documentation
                        // we'll look for the existence of a failure reason
                        modelStatus.status === LuisApi.TrainingStatuses.UpToDate || !!modelStatus.failureReason);
                    this.emit('trainingProgress', finishedModels.length, trainingStatus.length);
                    // let finished = trainingStatus.every(modelStatus =>
                    //     modelStatus.status === LuisApi.TrainingStatuses.UpToDate || !!modelStatus.failureReason
                    // );
                    if (finishedModels.length < trainingStatus.length) {
                        return waitForTraining();
                    }
                    // Look for failures
                    let failedModels = trainingStatus.filter(modelStatus => modelStatus.failureReason);
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
        return this.luisApiClient.startTraining()
            .then(() => waitForTraining())
            // TODO: Catch the error when there already is a training ongoing to wait for it
            .catch(err => this.wrapError(err, 'Error trying to train models'));
    }

    private publish(): Promise<void> {
        this.emit('startPublish');
        return this.luisApiClient.publish()
            .then(publishResult => {
                this.emit('endPublish');
            })
            .catch(err => this.wrapError(err, 'Error trying to publish the app'));
    }

    /**
     * Find the entity text inside the sentence from its start and end positions.
     */
    private recognizeEntity(sentence: string, startPos: number, endPos: number): RecognizedEntity {
        if (!sentence || sentence.trim().length === 0) {
            return null;
        }
        let originalSentence = sentence;
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

        interface Token {
            token: string;
            startChar: number;
            endChar: number;
        }
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

        if (startPos < 0 || startPos >= tokens.length || endPos < 0 || endPos >= tokens.length) {
            throw new Error('Entity positions are out of range');
        }
        let startChar = tokens[startPos].startChar;
        let endChar = tokens[endPos].endChar;
        let word = originalSentence.slice(startChar, endChar + 1);
        return {
            word,
            startChar,
            endChar
        };
    }

}
