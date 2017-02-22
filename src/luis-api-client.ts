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

import * as request from 'request-promise-native';
import * as _ from 'lodash';
const promiseRetry = require('promise-retry');
const PromiseThrottle = require('promise-throttle');
import { EventEmitter } from 'events';
import { RequestResponse } from 'request';
// Fix the `RequestResponse` interface exported by the `request` module which is missing the `body` property
declare module 'request' {
    interface RequestResponse {
        body?: any;
    }
}

export namespace LuisApi {
    export interface RecognizedEntity {
        entity: string;
        type: string;
        startIndex: number;
        endIndex: number;
    }

    export interface RecognitionResult {
        sentence: string;
        intent: string;
        entities: RecognizedEntity[];
    }

    export interface AppInfo {
        id: string;
        name: string;
        description: string;
        culture: string;
        active: boolean;
        numberOfIntents: number;
        numberOfEntities: number;
        isTrained: boolean;
    }

    export interface IntentClassifier {
        id: string;
        name: string;
    }

    export interface EntityExtractor {
        id: string;
        name: string;
    }

    export enum PhraseListModes { Exchangeable, NonExchangeable }

    export interface PhraseList {
        id?: string;
        name: string;
        mode: PhraseListModes;
        isActive?: boolean;
        editable?: boolean;
        phrases: string;
    }

    export interface LabeledEntity {
        name: string;
        startToken: number;
        endToken: number;
        word: string;
        isBuiltInExtractor: boolean;
    }

    export interface LabeledUtterance {
        id: string;
        utteranceText: string;
        tokenizedText: string[];
        intent: string;
        predictedIntents: [{
            name: string;
            score: number;
        }];
        entities: LabeledEntity[];
        predictedEntities: LabeledEntity[];
    }

    export interface Entity {
        entityType: string;
        startToken: number;
        endToken: number;
    }

    export interface Example {
        exampleText: string;
        selectedIntentName: string;
        entityLabels?: Entity[];
    }

    export enum TrainingStatuses { Success = 0, Failed = 1, UpToDate = 2, InProgress = 3 }

    export interface ModelTrainingStatus {
        modelId: string;
        status: TrainingStatuses;
        exampleCount: number;
        failureReason?: string;
    }

    export type TrainingStatus = ModelTrainingStatus[];

    export interface PublishResult {
        url: string;
        subscriptionKey: string;
        publishDate: Date;
    }
}

const LUIS_API_BASE_URL = 'https://westus.api.cognitive.microsoft.com';
// Alternative endpoint only for the service API in order to use the private endpoint deployed in EU
const LUIS_SERVICE_API_BASE_URL = 'http://luis-europe-west-endpoint.cloudapp.net';
const RETRY_OPTS = {
    retries: 10,
    factor: 2,
    minTimeout: 1500
};
// Maximum number of parallel requests per second to send to the API (to minimize 429 rate errors)
const REQUESTS_PER_SECOND = 4;
const SERVICE_API_REQUESTS_PER_SECOND = 20;  // The private endpoint is not throttled
// count parameter of the getExamples API (the API doesn't support more than 100)
const MAX_EXAMPLES_COUNT = 100;
// Number of parallel getExamples requests to get all the examples (still rated by REQUESTS_PER_SECOND)
const MAX_PARALLEL_EXAMPLES_REQUESTS = 15;
// Maximum number of examples that can be created at the same time (the API doesn't support more than 100)
const MAX_EXAMPLES_UPLOAD = 100;

export interface LuisApiClientConfig {
    baseUrl?: string;
    applicationId: string;
    subscriptionKey: string;
    requestsPerSecond?: number;
}

export class LuisApiClient extends EventEmitter {
    protected applicationId: string = null;
    private readonly serviceReq: any;
    private readonly provisionReq: any;
    private readonly promiseThrottle: any;

    constructor(config: LuisApiClientConfig) {
        super();
        this.applicationId = config.applicationId;
        let baseUrl = config.baseUrl || LUIS_API_BASE_URL;
        this.serviceReq = request.defaults({
            // XXX: the public service API use a slightly different path, so this should be changed in the future
            baseUrl: `${LUIS_SERVICE_API_BASE_URL}/api/v2.0/apps/${this.applicationId}`,
            qs: {
                'subscription-key': config.subscriptionKey,
                verbose: false,
                spellCheck: false
            },
            json: true,
            simple: false,
            resolveWithFullResponse: true
        });
        this.provisionReq = request.defaults({
            baseUrl: `${baseUrl}/luis/v1.0/prog/apps`,
            headers: {
                'Ocp-Apim-Subscription-Key': config.subscriptionKey
            },
            json: true,
            simple: false,
            resolveWithFullResponse: true
        });
        this.promiseThrottle = new PromiseThrottle({
            requestsPerSecond: config.requestsPerSecond || REQUESTS_PER_SECOND,
            promiseImplementation: Promise
        });
    }

    /**
     * Sends a request gracefully managing "429 Too many requests" errors, retrying the request a bit later
     */
    private retryRequest(opts: request.Options, expectedStatusCode: number): Promise<RequestResponse> {
        return promiseRetry((retry: Function, number: number) => {
            return this.provisionReq(opts)
                .then((res: RequestResponse) => {
                    if (res.statusCode === 429) {
                        this.emit('tooManyRequests');
                        return retry(new Error('LuisApiClient: The maximum number of retries has been reached'));
                    }
                    if (res.statusCode !== expectedStatusCode) {
                        return Promise.reject(new Error(`LuisApiClient: Unexpected status code: ${res.statusCode}:\n` +
                            JSON.stringify(res.body, null, 2)));
                    }
                    return res;
                });
        }, RETRY_OPTS);
    }

    /**
     * Executes `fn` once per each element in `items` in parallel but throttling the execution
     */
    private throttler(fn: Function, items: any[]): Promise<any> {
        let promises = items.map(item => this.promiseThrottle.add(fn.bind(this, item)));
        return Promise.all(promises);
    }

    recognizeSentence(sentence: string): Promise<LuisApi.RecognitionResult> {
        let opts: request.Options = {
            method: 'GET',
            uri: '',
            qs: { q: sentence }
        };
        return this.serviceReq(opts)
            .then((res: RequestResponse) => {
                if (res.statusCode !== 200) {
                    return Promise.reject(new Error(`LuisApiClient: Unexpected status code: ${res.statusCode}:\n` +
                        JSON.stringify(res.body, null, 2)));
                }

                this.emit('recognizeSentence', sentence);
                return {
                    sentence: res.body.query,
                    intent: res.body.topScoringIntent.intent,
                    entities: res.body.entities.map((entity: any) => {
                        return {
                            entity: entity.entity,
                            type: entity.type,
                            startIndex: entity.startIndex,
                            endIndex: entity.endIndex
                        } as LuisApi.RecognizedEntity;
                    })
                } as LuisApi.RecognitionResult;
            });
    }

    recognizeSentences(sentences: string[]): Promise<LuisApi.RecognitionResult[]> {
        let promiseThrottle = new PromiseThrottle({
            requestsPerSecond: SERVICE_API_REQUESTS_PER_SECOND,
            promiseImplementation: Promise
        });
        let promises = sentences.map(sentence => promiseThrottle.add(this.recognizeSentence.bind(this, sentence)));
        return Promise.all(promises) as Promise<LuisApi.RecognitionResult[]>;
    }

    getApp(): Promise<LuisApi.AppInfo> {
        let opts: request.Options = {
            method: 'GET',
            uri: this.applicationId
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body)
            .then(body => {
                return {
                    id: body.ID,
                    name: body.Name,
                    description: body.Description,
                    culture: body.Culture,
                    active: body.Active,
                    numberOfIntents: body.NumberOfIntents,
                    numberOfEntities: body.NumberOfEntities,
                    isTrained: body.IsTrained
                } as LuisApi.AppInfo;
            });
    }

    getIntents(): Promise<LuisApi.IntentClassifier[]> {
        let opts: request.Options = {
            method: 'GET',
            uri: `${this.applicationId}/intents`
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body)
            .then((intents) => intents.map((intent: any) => {
                return {
                    id: intent.id,
                    name: intent.name
                } as LuisApi.IntentClassifier;
            }));
    }

    createIntent(intentName: string): Promise<string> {
        let opts: request.Options = {
            method: 'POST',
            uri: `${this.applicationId}/intents`,
            body: { name: intentName }
        };
        return this.retryRequest(opts, 201)
            .then((res: RequestResponse) => res.body)
            .then(intentId => {
                this.emit('createIntent', {
                    id: intentId,
                    name: intentName
                });
                return intentId;
            });
    }

    createIntents(intentNames: string[]): Promise<string[]> {
        return this.throttler(this.createIntent, intentNames) as Promise<string[]>;
    }

    deleteIntent(intentId: string): Promise<void> {
        let opts: request.Options = {
            method: 'DELETE',
            uri: `${this.applicationId}/intents/${intentId}`
        };
        return this.retryRequest(opts, 200)
            .then(() => {
                this.emit('deleteIntent', intentId);
            });
    }

    deleteIntents(intentIds: string[]): Promise<void> {
        return this.throttler(this.deleteIntent, intentIds)
            .then(() => Promise.resolve());

    }

    getEntities(): Promise<LuisApi.EntityExtractor[]> {
        let opts: request.Options = {
            method: 'GET',
            uri: `${this.applicationId}/entities`
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body)
            .then((entities) => entities.map((entity: any) => {
                return {
                    id: entity.id,
                    name: entity.name
                } as LuisApi.EntityExtractor;
            }));
    }

    createEntity(entityName: string): Promise<string> {
        let opts: request.Options = {
            method: 'POST',
            uri: `${this.applicationId}/entities`,
            body: { name: entityName }
        };
        return this.retryRequest(opts, 201)
            .then((res: RequestResponse) => res.body)
            .then(entityId => {
                this.emit('createEntity', {
                    id: entityId,
                    name: entityName
                });
                return entityId;
            });
    }

    createEntities(entityNames: string[]): Promise<string[]> {
        return this.throttler(this.createEntity, entityNames) as Promise<string[]>;
    }

    deleteEntity(entityId: string): Promise<void> {
        let opts: request.Options = {
            method: 'DELETE',
            uri: `${this.applicationId}/entities/${entityId}`
        };
        return this.retryRequest(opts, 200)
            .then(() => {
                this.emit('deleteEntity', entityId);
            });
    }

    deleteEntities(entityIds: string[]): Promise<void> {
        return this.throttler(this.deleteEntity, entityIds)
            .then(() => Promise.resolve());
    }

    getPhraseLists(): Promise<LuisApi.PhraseList[]> {
        let opts: request.Options = {
            method: 'GET',
            uri: `${this.applicationId}/phraselists`
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body)
            .then((phraseLists) => phraseLists.map((phraseList: any) => {
                return {
                    id: phraseList.Id.toString(),
                    name: phraseList.Name,
                    mode: phraseList.Mode.toLowerCase() === 'non-exchangeable' ?
                        LuisApi.PhraseListModes.NonExchangeable : LuisApi.PhraseListModes.Exchangeable,
                    isActive: phraseList.IsActive,
                    editable: phraseList.Editable,
                    phrases: phraseList.Phrases
                } as LuisApi.PhraseList;
            }));
    }

    createPhraseList(phraseList: LuisApi.PhraseList): Promise<string> {
        let opts: request.Options = {
            method: 'POST',
            uri: `${this.applicationId}/phraselists`,
            body: {
                    Name: phraseList.name,
                    Mode: phraseList.mode === LuisApi.PhraseListModes.NonExchangeable ?
                        'Non-exchangeable' : 'Exchangeable',
                    IsActive: phraseList.isActive !== undefined ? phraseList.isActive : true,
                    Editable: phraseList.editable !== undefined ? phraseList.editable : true,
                    Phrases: phraseList.phrases
                }
        };
        return this.retryRequest(opts, 201)
            .then((res: RequestResponse) => res.body)
            .then(phraseListId => {
                this.emit('createPhraseList', {
                    id: phraseListId,
                    name: phraseList.name
                });
                return phraseListId;
            });
    }

    createPhraseLists(phraseLists: LuisApi.PhraseList[]): Promise<string[]> {
        return this.throttler(this.createPhraseList, phraseLists) as Promise<string[]>;
    }

    deletePhraseList(phraseListId: string): Promise<void> {
        let opts: request.Options = {
            method: 'DELETE',
            uri: `${this.applicationId}/phraselists/${phraseListId}`
        };
        return this.retryRequest(opts, 200)
            .then(() => {
                this.emit('deletePhraseList', phraseListId);
            });
    }

    deletePhraseLists(phraseListIds: string[]): Promise<void> {
        return this.throttler(this.deletePhraseList, phraseListIds)
            .then(() => Promise.resolve());
    }

    getExamples(skip: number, count: number): Promise<LuisApi.LabeledUtterance[]> {
        function mapEntities(entities: any[]): LuisApi.LabeledEntity[] {
            return entities.map((entity: any) => {
                return {
                    name: entity.name,
                    startToken: entity.indeces.startToken,
                    endToken: entity.indeces.endToken,
                    word: entity.word,
                    isBuiltInExtractor: entity.isBuiltInExtractor
                } as LuisApi.LabeledEntity;
            });
        }

        let opts: request.Options = {
            method: 'GET',
            uri: `${this.applicationId}/examples`,
            qs: { skip, count }
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => {
                let examples = res.body;
                if (examples.length) {
                    // Don't emit events once the last example has been reached
                    this.emit('getExamples', skip, skip + examples.length - 1);
                }
                return examples;
            })
            .then(examples => examples.map((example: any) => {
                return {
                    id: example.exampleId,
                    utteranceText: example.utteranceText,
                    tokenizedText: example.tokenizedText,
                    intent: example.IntentsResults.Name,
                    predictedIntents: example.PredictedIntentResults.map((intent: any) => {
                        return {
                            name: intent.Name,
                            score: intent.score
                        };
                    }),
                    entities: mapEntities(example.EntitiesResults),
                    predictedEntities: mapEntities(example.PredictedEntitiesResults)
                } as LuisApi.LabeledUtterance;
            }));
    }

    /**
     * Get all the examples by concurrently getting bunches of examples in order to speed up the operation
     */
    getAllExamples(): Promise<LuisApi.LabeledUtterance[]> {
        let examplesBunches: LuisApi.LabeledUtterance[][] = [];

        // Recursively get examples in bunches of MAX_PARALLEL_EXAMPLES_REQUESTS parallel requests
        const getExamplesBunch = (skip: number = 0): Promise<void> => {
            // List of skip argument value to be used in getExamples call
            let skipList = Array.from(Array(MAX_PARALLEL_EXAMPLES_REQUESTS))
                .map((e, i) => skip + i * MAX_EXAMPLES_COUNT);
            let promises = skipList.map(skip => this.promiseThrottle.add(this.getExamples.bind(this, skip, MAX_EXAMPLES_COUNT)));
            return Promise.all(promises)
                .then((examplesBunch: LuisApi.LabeledUtterance[][]) => {
                    let lastBunchFound = examplesBunch.some(bunch => {
                        if (bunch.length) {
                            examplesBunches.push(bunch);
                        }
                        return bunch.length < MAX_EXAMPLES_COUNT;  // Is it the last bunch?
                    });
                    if (!lastBunchFound) {
                        // Recursively get the next bunch of examples
                        return getExamplesBunch(skip + MAX_PARALLEL_EXAMPLES_REQUESTS * MAX_EXAMPLES_COUNT);
                    }
                });
        };

        return getExamplesBunch().then(() => _.flatten(examplesBunches));
    }

    createExamples(examples: LuisApi.Example[]): Promise<string[]> {
        // Create examples up to MAX_EXAMPLES_UPLOAD
        let createLimitedExamples = (examples: LuisApi.Example[]) => {
            let opts: request.Options = {
                method: 'POST',
                uri: `${this.applicationId}/examples`,
                body: examples
            };
            return this.retryRequest(opts, 201)
                .then((res: RequestResponse) => res.body)
                .then((body: any[]) => {
                    let errors = body.filter(r => r.hasError);
                    if (errors.length) {
                        return Promise.reject(new Error('LuisApiClient: The following examples have errors:\n'
                            + JSON.stringify(errors, null, 2)));
                    }
                    this.emit('createExampleBunch', examples.length);
                    return body.map(r => r.value.ExampleId.toString());
                });
        };

        // LUIS API supports up to 100 examples at the same time
        let examplesBunches = _.chunk(examples, MAX_EXAMPLES_UPLOAD);
        return this.throttler(createLimitedExamples, examplesBunches)
            .then(_.flatten);
    }

    deleteExample(exampleId: string): Promise<void> {
        let opts: request.Options = {
            method: 'DELETE',
            uri: `${this.applicationId}/examples/${exampleId}`
        };
        return this.retryRequest(opts, 200)
            .then(() => {
                this.emit('deleteExample', exampleId);
            });
    }

    deleteExamples(exampleIds: string[]): Promise<void> {
        return this.throttler(this.deleteExample, exampleIds)
            .then(() => Promise.resolve());
    }

    private convertTrainingStatus(apiTrainingStatus: any[]): LuisApi.TrainingStatus {
        return apiTrainingStatus.map((modelStatus: any) => {
            let modelTrainingStatus: LuisApi.ModelTrainingStatus = {
                modelId: modelStatus.ModelId,
                status: modelStatus.Details.StatusId as LuisApi.TrainingStatuses,
                exampleCount: modelStatus.Details.ExampleCount
            };
            if (modelTrainingStatus.status === LuisApi.TrainingStatuses.Failed) {
                modelTrainingStatus.failureReason = modelStatus.Details.FailureReason;
            }
            return modelTrainingStatus;
        });
    }

    startTraining(): Promise<LuisApi.TrainingStatus> {
        let opts: request.Options = {
            method: 'POST',
            uri: `${this.applicationId}/train`
        };
        return this.retryRequest(opts, 202)
            .then((res: RequestResponse) => res.body)
            .then(this.convertTrainingStatus);
    }

    getTrainingStatus(): Promise<LuisApi.TrainingStatus> {
        let opts: request.Options = {
            method: 'GET',
            uri: `${this.applicationId}/train`
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body)
            .then(this.convertTrainingStatus);
    }

    publish(): Promise<LuisApi.PublishResult> {
        let opts: request.Options = {
            method: 'POST',
            uri: `${this.applicationId}/publish`,
            // We don't really know what this body is for but it must be included for the API to work
            body: {
                BotFramework: { Enabled: false, AppId: '', SubscriptionKey: '', Endpoint: '' },
                Slack: { Enabled: false, ClientId: '', ClientSecret: '', RedirectUri: '' },
                PrivacyStatement: '',
                TermsOfUse: ''
            }
        };
        return this.retryRequest(opts, 201)
            .then((res: RequestResponse) => res.body)
            .then(body => {
                return {
                    url: body.URL,
                    subscriptionKey: body.SubscriptionKey,
                    publishDate: new Date(body.PublishDate)
                } as LuisApi.PublishResult;
            });
    }

    export(): Promise<any> {
        let opts: request.Options = {
            method: 'GET',
            uri: `${this.applicationId}/export`
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body);
    }

}
