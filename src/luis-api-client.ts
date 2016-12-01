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
import * as url from 'url';
import * as logger from 'logops';
import * as _ from 'lodash';

const request = require('request-promise-native');

export namespace Luis {
    export interface UtteranceEntity {
        entity: string;
        startPos: number;
        endPos: number;
    }

    export interface Utterance {
        text: string;
        intent: string;
        id?: string;
        entities: UtteranceEntity[];
    }

    export interface UpdateUtteranceResult {
        utteranceText: string;
        has_error: boolean;
        error: string;
    }

    export interface TrainingStatusDetails {
        statusId: number;
        status: string;
        trainingTime: string;
        exampleCount: number;
        trainingDuration: string;
        failureReason: string;
    }

    export interface TrainingStatus {
        modelId: string;
        details: TrainingStatusDetails;
    }

    export interface AppPublishData {
        url: string;
        previewUrl: string;
        subscriptionKey: string;
        publishDate: string;
    }
}

export class LuisClient {
    BASE_API_PATH = 'https://api.projectoxford.ai/luis/v1.0/prog/apps/';
    _baseRequest: any = null;
    DEFAULT_PAGE_SIZE = 100;

    constructor(subscriptionId: string) {
        this._baseRequest = request.defaults({
            baseUrl: this.BASE_API_PATH,
            headers: {
                'Ocp-Apim-Subscription-Key': subscriptionId,
                'Accept': 'application/json'
            },
            json: true
        });
    }

    export(appId: string): Promise<Object> {
        logger.debug('Exporting application %s', appId);
        return this._baseRequest(`${appId}/export`);
    }

    import(appName: string, appData: Object): Promise<Object> {
        logger.debug('Importing application %s', appName);
        return this._baseRequest.defaults({body: appData}).post(`/import?appName=${appName}`);
    }

    getUtterances(appId: string, skip: number = 0, count: number = this.DEFAULT_PAGE_SIZE): Promise<Luis.Utterance[]> {
        logger.debug('Getting utterances for application %s', appId);
        return this._baseRequest(`${appId}/examples?skip=${skip}&count=${count}`)
            .then((apiExamples: any) => {
                // Convert from api schema (utterances are called examples) to app data json schema
                let utterances = apiExamples.map((apiExample: any) => {
                    let entities = apiExample.EntitiesResults.map((item: any) => {
                        return {
                            entity: item.name,
                            startPos: item.indeces.startToken,
                            endPos: item.indeces.endToken
                        };
                    });
                    return {
                        text: apiExample.utteranceText,
                        intent: apiExample.IntentsResults.Name,
                        id: apiExample.exampleId,
                        entities: entities
                    };
                });
                return utterances;
            })
            .catch((err: any) => {
                throw err;
            });
    }

    /**
     * Updates already existing utterances and creates new ones if they not existed before
     */
    upsertUtterances(appId: string, utterances: Luis.Utterance[]): Promise<Luis.UpdateUtteranceResult[]> {
        logger.debug('Batch upsert of utterances for application %s', appId);
        // Convert from app data json schema to api schema (utterances are called examples)
        let apiExamples = utterances.map((utterance) => {
            let entityLabels = utterance.entities.map((entity) => {
                return {
                    EntityType: entity.entity,
                    StartToken: this.getStartChar(utterance.text, entity.startPos),
                    EndToken: this.getEndChar(utterance.text, entity.endPos)
                };
            });
            return {
                ExampleText: utterance.text,
                SelectedIntentName: utterance.intent,
                EntityLabels: entityLabels
            };
        });

        let _baseRequest = this._baseRequest;
        let promise = Promise.resolve();
        _.chunk(apiExamples, 100).forEach(chunk => {
            promise = promise.then(() => performRequest(chunk));
        });
        return promise;

        ///////

        function performRequest(examples: any) {
            //parse and convert response to Luis.UpdateUtteranceResult schema
            return _baseRequest.defaults({body: examples})
                .post(`${appId}/examples`)
                .then((response: any) => {
                    let updateResult = response.map((result: any) => {
                        return {
                            utteranceText: result.value.UtteranceText,
                            has_error: result.has_error,
                            error: result.error
                        };
                    });
                    return updateResult;
                })
                .catch((err: any) => {
                    throw err;
                });
        }

    }

    deleteUtterance(appId: string, utterance: Luis.Utterance): Promise<boolean> {
        logger.debug('Deleting utterance for application %s', appId);
        return this._baseRequest.defaults({json: false, resolveWithFullResponse: true})
            .delete(`${appId}/examples/${utterance.id}`)
            .then((response: any) => {
                let success = response.statusCode === 200;
                return success;
            })
            .catch((err: any) => {
                throw err;
            });
    }

    startTraining(appId: string): Promise<boolean> {
        logger.debug('Triggering training for application %s', appId);
        return this._baseRequest.defaults({resolveWithFullResponse: true})
            .post(`${appId}/train`)
            .then((response: any) => {
                let success = response.statusCode === 202;
                return success;
            })
            .catch((err: any) => {
                throw err;
            });
    }

    getTrainingStatus(appId: string): Promise<Luis.TrainingStatus[]> {
        logger.debug('Getting training status for application %s', appId);
        return this._baseRequest(`${appId}/train`)
            .then((trainingStatusAPI: any) => {
              // Convert from api schema to our data interface
              let trainingStatus = trainingStatusAPI.map((status: any) => {
                  return {
                      modelId: status.ModelId,
                      details: {
                          statusId: status.Details.StatusId,
                          status: status.Details.Status,
                          trainingTime: status.Details.TrainingTime,
                          exampleCount: status.Details.ExampleCount,
                          trainingDuration: status.Details.TrainingDuration,
                          failureReason: status.Details.FailureReason
                      }
                  };
              });
              return trainingStatus;
          })
          .catch((err: any) => {
              throw err;
          });
    }

    publish(appId: string): Promise<Luis.AppPublishData> {
        logger.debug('Publishing application %s', appId);
        // This has to be done as a workaround as this 'useless' body is required by LUIS API.
        let publishBody = {
            BotFramework: {
                Enabled: true,
                AppId: 'string',
                SubscriptionKey: 'string',
                Endpoint: 'string'
            },
            Slack: {
                Enabled: true,
                ClientId: 'string',
                ClientSecret: 'string',
                RedirectUri: 'string'
            }
        };

        return this._baseRequest.defaults({body: publishBody})
            .post(`${appId}/publish`)
            .then((response: any) => {
                return {
                    url: response.URL,
                    previewUrl: response.PreviewURL,
                    subscriptionKey: response.SubscriptionKey,
                    publishDate: response.PublishDate
                };
            })
            .catch((err: any) => {
                throw err;
            });
    }

    getStartChar(text: string, startPos: number): number {
        let tokens = text.split(' ');
        return text.indexOf(tokens[startPos]);
    }

    getEndChar(text: string, endPos: number): number {
        let tokens = text.split(' ');
        return text.indexOf(tokens[endPos]) + tokens[endPos].length - 1;
    }
}
