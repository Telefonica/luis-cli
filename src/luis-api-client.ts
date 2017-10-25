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

const DEFAULT_REGION = 'westus';

export namespace LuisApi {
    /* See: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c37 */
    export interface AppInfoGET {
        id: string;
        name: string;
        description: string;
        culture: string;
    }

    /*
        See:
        - GET: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c0d
        - POST: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c0c
        - DELETE: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c1c
    */
    export interface IntentGET {
        id: string;
        name: string;
        typeId: number;
        readableType: string;
    }
    export interface IntentPOST {
        name: string;
    }
    export interface IntentDELETE {
        id: string;
    }

    /*
        See:
        - GET: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c0f
        - POST: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c0e
        - DELETE: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c1f
    */
    export interface EntityGET {
        id: string;
        name: string;
        typeId: number;
        readableType: string;
    }
    export interface EntityPOST {
        name: string;
    }
    export interface EntityDELETE {
        id: string;
    }

    /*
        See:
        - GET: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c00
        - POST: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9bff
        - DELETE: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c07
    */
    export interface PhraseListGET {
        id: number;
        name: string;
        isActive: boolean;
        isExchangeable: boolean;
        phrases: string;
    }
    export interface PhraseListPOST {
        name: string;
        phrases: string;
        isExchangeable: boolean;
    }
    export interface PhraseListDELETE {
        id: string;
    }

    /*
        See:
        - GET: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c0a
        - POST: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c08
        - DELETE: https://westus.dev.cognitive.microsoft.com/docs/services/5890b47c39e2bb17b84a55ff/operations/5890b47c39e2bb052c5b9c0b
    */
    export interface EntityLabelExampleGET {
        entityName: string;
        startTokenIndex: number;
        endTokenIndex: number;
    }
    export interface EntityLabelExamplePOST {
        entityName: string;
        startCharIndex: number;
        endCharIndex: number;
    }
    export interface IntentPrediction {
        name: string;
        score: number;
    }
    export interface EntityPrediction {
        entityName: string;
        startIndex: number;
        endIndex: number;
        phrase: string;
    }
    export interface ExampleGET {
        id: number;
        text: string;
        tokenizedText: string[];
        intentLabel: string;
        entityLabels: EntityLabelExampleGET[];
        intentPredictions: IntentPrediction[];
        entityPredictions: EntityPrediction[];
    }
    export interface ExamplePOST {
        text: string;
        intentName: string;
        entityLabels: EntityLabelExamplePOST[];
    }
    export interface ExampleDELETE {
        id: number;
    }

    /*
        See:
        - GET: https://westus.dev.cognitive.microsoft.com/docs/services/5819c76f40a6350ce09de1ac/operations/5819c77140a63516d81aee78
    */
    export interface RecognizedIntent {
        intent: string;
        score: number;
    }
    export interface RecognizedEntity {
        entity: string;
        type: string;
        startIndex: number;
        endIndex: number;
        score: number;
    }
    export interface RecognitionResult {
        query: string;
        topScoringIntent: RecognizedIntent;
        intents: RecognizedIntent[];
        entities: RecognizedEntity[];
    }

    export enum TrainingStatuses { Success = 0, Fail = 1, UpToDate = 2, InProgress = 3 }

    export interface ModelTrainingStatus {
        modelId: string;
        status: TrainingStatuses;
        exampleCount: number;
        failureReason?: string;
    }

    export type TrainingStatus = ModelTrainingStatus[];

    export interface PublishResult {
        endpointUrl: string;
        subscriptionKey: string;
        endpointRegion: string;
        isStaging: boolean;
    }
}

const LUIS_API_BASE_URL = 'https://westus.api.cognitive.microsoft.com';
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
            baseUrl: `${baseUrl}/luis/v2.0/apps/`,
            headers: {
                'Ocp-Apim-Subscription-Key': config.subscriptionKey
            },
            json: true,
            simple: false,
            resolveWithFullResponse: true
        });
        this.provisionReq = request.defaults({
            baseUrl: `${baseUrl}/luis/api/v2.0/apps/`,
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
    private throttler(fn: Function, appVersion: string, items: any[]): Promise<any> {
        let promises = items.map(item => this.promiseThrottle.add(fn.bind(this, appVersion, item)));
        return Promise.all(promises);
    }

    recognizeSentence(sentence: string): Promise<LuisApi.RecognitionResult> {
        let opts: request.Options = {
            method: 'GET',
            uri: `/${this.applicationId}`,
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
                    query: res.body.query,
                    topScoringIntent: res.body.topScoringIntent,
                    intents: res.body.intents,
                    entities: res.body.entities.map((entity: any) => {
                        return {
                            entity: entity.entity,
                            type: entity.type,
                            startIndex: entity.startIndex,
                            endIndex: entity.endIndex,
                            score: entity.score
                        } as LuisApi.RecognizedEntity;
                    })
                } as LuisApi.RecognitionResult;
            });
    }

    recognizeSentences(queries: string[]): Promise<LuisApi.RecognitionResult[]> {
        let promiseThrottle = new PromiseThrottle({
            requestsPerSecond: SERVICE_API_REQUESTS_PER_SECOND,
            promiseImplementation: Promise
        });
        let promises = queries.map(query => promiseThrottle.add(this.recognizeSentence.bind(this, query)));
        return Promise.all(promises) as Promise<LuisApi.RecognitionResult[]>;
    }

    getApp(): Promise<LuisApi.AppInfoGET> {
        let opts: request.Options = {
            method: 'GET',
            uri: `/${this.applicationId}`
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body)
            .then(body => {
                return {
                    id: body.id,
                    name: body.name,
                    description: body.description,
                    culture: body.culture
                } as LuisApi.AppInfoGET;
            });
    }

    getIntents(appVersion: string): Promise<LuisApi.IntentGET[]> {
        let opts: request.Options = {
            method: 'GET',
            uri: `/${this.applicationId}/versions/${appVersion}/intents`
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body as LuisApi.IntentGET[]);
    }

    createIntent(appVersion: string, intent: LuisApi.IntentPOST): Promise<string> {
        let opts: request.Options = {
            method: 'POST',
            uri: `/${this.applicationId}/versions/${appVersion}/intents`,
            body: intent
        };
        return this.retryRequest(opts, 201)
            .then((res: RequestResponse) => {
                this.emit('createIntent', {
                    id: res.body,
                    name: intent.name
                });
                return res.body;
            });
    }

    createIntents(appVersion: string, intents: LuisApi.IntentPOST[]): Promise<string[]> {
        return this.throttler(this.createIntent, appVersion, intents) as Promise<string[]>;
    }

    deleteIntent(appVersion: string, intent: LuisApi.IntentDELETE): Promise<void> {
        let opts: request.Options = {
            method: 'DELETE',
            uri: `/${this.applicationId}/versions/${appVersion}/intents/${intent.id}`
        };
        return this.retryRequest(opts, 200)
            .then(() => {
                this.emit('deleteIntent', intent.id);
            });
    }

    deleteIntents(appVersion: string, intents: LuisApi.IntentDELETE[]): Promise<void> {
        return this.throttler(this.deleteIntent, appVersion, intents)
            .then(() => Promise.resolve());

    }

    getEntities(appVersion: string): Promise<LuisApi.EntityGET[]> {
        let opts: request.Options = {
            method: 'GET',
            uri: `/${this.applicationId}/versions/${appVersion}/entities`
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body as LuisApi.EntityGET[]);
    }

    createEntity(appVersion: string, entity: LuisApi.EntityPOST): Promise<string> {
        let opts: request.Options = {
            method: 'POST',
            uri: `/${this.applicationId}/versions/${appVersion}/entities`,
            body: entity
        };
        return this.retryRequest(opts, 201)
            .then((res: RequestResponse) => {
                this.emit('createEntity', {
                    id: res.body,
                    name: entity.name
                });
                return res.body;
            })
            .catch(err => console.log(JSON.stringify(err)));
    }

    createEntities(appVersion: string, entities: LuisApi.EntityPOST[]): Promise<string[]> {
        return this.throttler(this.createEntity, appVersion, entities) as Promise<string[]>;
    }

    deleteEntity(appVersion: string, entity: LuisApi.EntityDELETE): Promise<void> {
        let opts: request.Options = {
            method: 'DELETE',
            uri: `/${this.applicationId}/versions/${appVersion}/entities/${entity.id}`
        };
        return this.retryRequest(opts, 200)
            .then(() => {
                this.emit('deleteEntity', entity.id);
            });
    }

    deleteEntities(appVersion: string, entities: LuisApi.EntityDELETE[]): Promise<void> {
        return this.throttler(this.deleteEntity, appVersion, entities)
            .then(() => Promise.resolve());
    }

    getPhraseLists(appVersion: string): Promise<LuisApi.PhraseListGET[]> {
        let opts: request.Options = {
            method: 'GET',
            uri: `/${this.applicationId}/versions/${appVersion}/phraselists`
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body as LuisApi.PhraseListGET[]);
    }

    createPhraseList(appVersion: string, phraseList: LuisApi.PhraseListPOST): Promise<string> {
        let opts: request.Options = {
            method: 'POST',
            uri: `/${this.applicationId}/versions/${appVersion}/phraselists`,
            body: phraseList
        };
        return this.retryRequest(opts, 201)
            .then((res: RequestResponse) => {
                this.emit('createPhraseList', {
                    id: res.body,
                    name: phraseList.name
                });
                return res.body;
            });
    }

    createPhraseLists(appVersion: string, phraseLists: LuisApi.PhraseListPOST[]): Promise<string[]> {
        return this.throttler(this.createPhraseList, appVersion, phraseLists) as Promise<string[]>;
    }

    deletePhraseList(appVersion: string, phraseList: LuisApi.PhraseListDELETE): Promise<void> {
        let opts: request.Options = {
            method: 'DELETE',
            uri: `/${this.applicationId}/versions/${appVersion}/phraselists/${phraseList.id}`
        };
        return this.retryRequest(opts, 200)
            .then(() => {
                this.emit('deletePhraseList', phraseList.id);
            });
    }

    deletePhraseLists(appVersion: string, phraseLists: LuisApi.PhraseListDELETE[]): Promise<void> {
        return this.throttler(this.deletePhraseList, appVersion, phraseLists)
            .then(() => Promise.resolve());
    }

    getExamples(appVersion: string, skip: number, count: number): Promise<LuisApi.ExampleGET[]> {
        let opts: request.Options = {
            method: 'GET',
            uri: `/${this.applicationId}/versions/${appVersion}/examples`,
            qs: { skip, count }
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => {
                if (res.body.length) {
                    // Don't emit events once the last example has been reached
                    this.emit('getExamples', skip, skip + res.body.length - 1);
                }
                return res.body as LuisApi.ExampleGET[];
            });
    }

    /**
     * Get all the examples by concurrently getting bunches of examples in order to speed up the operation
     */
    getAllExamples(appVersion: string): Promise<LuisApi.ExampleGET[]> {
        let examplesBunches: LuisApi.ExampleGET[][] = [];

        // Recursively get examples in bunches of MAX_PARALLEL_EXAMPLES_REQUESTS parallel requests
        const getExamplesBunch = (skip: number = 0): Promise<void> => {
            // List of skip argument value to be used in getExamples call
            let skipList = Array.from(Array(MAX_PARALLEL_EXAMPLES_REQUESTS))
                .map((e, i) => skip + i * MAX_EXAMPLES_COUNT);
            let promises = skipList.map(skip => this.promiseThrottle.add(
                this.getExamples.bind(this, appVersion, skip, MAX_EXAMPLES_COUNT)));
            return Promise.all(promises)
                .then((examplesBunch: LuisApi.ExampleGET[][]) => {
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

    createExamples(appVersion: string, examples: LuisApi.ExamplePOST[]): Promise<string[]> {
        // Create examples up to MAX_EXAMPLES_UPLOAD
        let createLimitedExamples = (appVersion: string, examples: LuisApi.ExamplePOST[]) => {
            let opts: request.Options = {
                method: 'POST',
                uri: `/${this.applicationId}/versions/${appVersion}/examples`,
                body: examples
            };
            return this.retryRequest(opts, 201)
                .then((res: RequestResponse) => {
                    let errors = res.body.filter((r: any) => r.hasError);
                    if (errors.length) {
                        return Promise.reject(new Error('LuisApiClient: The following examples have errors:\n'
                            + JSON.stringify(errors, null, 2)));
                    }
                    this.emit('createExampleBunch', examples.length);
                    return res.body.map((r: any) => r.value.ExampleId.toString());
                });
        };

        // LUIS API supports up to 100 examples at the same time
        let examplesBunches = _.chunk(examples, MAX_EXAMPLES_UPLOAD);
        return this.throttler(createLimitedExamples, appVersion, examplesBunches)
            .then(_.flatten);
    }

    deleteExample(appVersion: string, example: LuisApi.ExampleDELETE): Promise<void> {
        let opts: request.Options = {
            method: 'DELETE',
            uri: `/${this.applicationId}/versions/${appVersion}/examples/${example.id}`
        };
        return this.retryRequest(opts, 200)
            .then(() => {
                this.emit('deleteExample', example.id);
            });
    }

    deleteExamples(appVersion: string, examples: LuisApi.ExampleDELETE[]): Promise<void> {
        return this.throttler(this.deleteExample, appVersion, examples)
            .then(() => Promise.resolve());
    }

    private convertTrainingStatus(apiTrainingStatus: any[]): LuisApi.TrainingStatus {
        return apiTrainingStatus.map((modelStatus: any) => {
            let modelTrainingStatus: LuisApi.ModelTrainingStatus = {
                modelId: modelStatus.modelId,
                status: modelStatus.details.statusId as LuisApi.TrainingStatuses,
                exampleCount: modelStatus.details.exampleCount
            };
            if (modelTrainingStatus.status === LuisApi.TrainingStatuses.Fail) {
                modelTrainingStatus.failureReason = modelStatus.details.failureReason;
            }
            return modelTrainingStatus;
        });
    }

    startTraining(appVersion: string): Promise<LuisApi.TrainingStatus> {
        let opts: request.Options = {
            method: 'POST',
            uri: `/${this.applicationId}/versions/${appVersion}/train`
        };
        return this.retryRequest(opts, 202)
            .then((res: RequestResponse) => res.body);
    }

    getTrainingStatus(appVersion: string): Promise<LuisApi.TrainingStatus> {
        let opts: request.Options = {
            method: 'GET',
            uri: `/${this.applicationId}/versions/${appVersion}/train`
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body)
            .then(this.convertTrainingStatus);
    }

    publish(appVersion: string, region?: string, isStaging?: boolean): Promise<LuisApi.PublishResult> {
        let opts: request.Options = {
            method: 'POST',
            uri: `/${this.applicationId}/publish`,
            // We don't really know what this body is for but it must be included for the API to work
            body: {
                versionId: appVersion,
                isStaging: !!isStaging,
                region: region || DEFAULT_REGION
            }
        };
        return this.retryRequest(opts, 201)
            .then((res: RequestResponse) => res.body)
            .then(body => {
                return {
                    endpointUrl: body.endpointUrl,
                    subscriptionKey: body['subscription-key'],
                    endpointRegion: body.endpointRegion,
                    isStaging: body.isStaging
                } as LuisApi.PublishResult;
            });
    }

    export(appVersion: string): Promise<any> {
        let opts: request.Options = {
            method: 'GET',
            uri: `/${this.applicationId}/versions/${appVersion}/export`
        };
        return this.retryRequest(opts, 200)
            .then((res: RequestResponse) => res.body);
    }

}
