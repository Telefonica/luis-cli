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

import * as logger from 'logops';

import { LuisClient, Luis } from './luis-api-client';

export class LuisApp {
    private _appId: any = null;
    private _subscriptionId: any = null;
    private _luisClient: LuisClient = null;
    private PAGE_SIZE: number = 100;

    constructor (appId: string, subscriptionId: string) {
        this._appId = appId;
        this._subscriptionId = subscriptionId;
        this._luisClient = new LuisClient(subscriptionId);
    }

    export(): Promise<Object> {
        return this._luisClient.export(this._appId)
            .then((appObj: Object) => {
                logger.debug('App correctly exported with data: %j', appObj);
                return appObj;
            })
            .catch((err) => {
                logger.error(err, 'An error occurred while exporting');
                throw err;
            });
    }

    import(appName: string, appData: Object): Promise<string> {
        let newAppId: string;

        return this._luisClient.import(appName, appData)
            .then((appId: string) => {
                newAppId = appId;

                logger.debug('App data has been correctly imported under appId %s', newAppId);
                logger.debug('Import finished...');
                return newAppId;
            })
            .then((newAppId: string) => {
                logger.debug('Initiating training...');
                return this._luisClient.startTraining(newAppId);
            })
            .then(success => {
                 logger.debug('Waiting for training to finish...');
                 return this.waitForTraining(newAppId);
            })
            .then(success => {
                 logger.debug('Publishing app...');
                 return this._luisClient.publish(newAppId);
            })
            .then(publishData => {
                logger.debug('App update completed successfully. App publish data is: %j', publishData);
                return newAppId;
            })
            .catch((err) => {
                logger.error(err, 'An error occurred while importing the app');
                throw err;
            });
    }

    //This function orchestrates different actions to update the utterances of an application to be exactly the same as
    //those specified in appData
    //1.- taking the target appData, it updates in btach mode the existing utterances and creates new ones if necessary
    //2.- it checks the result of the update, producing an error if not all utterances were successfully updated
    //3.- In order to remove obsolete (or stale) utterances it:
    //3.A.- it gets all the utterances uploaded for the app
    //3.B.- it identifies which of them are no longer valid (stale) as they do not appear in appData
    //3.C.- it removes stale utterances
    //4.- it triggers training
    //5.- it waits for training to finish and identifies if there were errors or not
    //6.- TODO: publish the application if all the above steps were successful
    updateUtterances(appData: any): Promise<Luis.AppPublishData> {
        return this._luisClient.upsertUtterances(this._appId, appData.utterances)
            .then(response => {
                logger.debug('Batch update of utterances finished, checking the result...');
                return this.checkUpdate(response);
            })
            .then(success => {
                logger.debug('Getting all utterances currently published...');
                return this.getUtterances(this._appId);
            })
            .then(currentUtterances => {
                logger.debug('Searching for stale utterances...');
                return this.getStaleUtterances(appData, currentUtterances);
            })
            .then(staleUtterances => {
                logger.debug('Deleting stale utterances...');
                return this.deleteUtterances(staleUtterances);
            })
            .then(deletedUtterances => {
                logger.debug('%s utterances deleted. Initiating training...', deletedUtterances);
                return this._luisClient.startTraining(this._appId);
            })
            .then(success => {
                 logger.debug('Waiting for training to finish...');
                 return this.waitForTraining(this._appId);
            })
            .then(success => {
                 logger.debug('Publishing app...');
                 return this._luisClient.publish(this._appId);
            })
            .catch((err) => {
                logger.error(err, 'An error occurred while importing the app');
                throw err;
            });
    }

    checkUpdate(updateResults: Luis.UpdateUtteranceResult[]): Promise<boolean> {
        let checkUpdatePromise: Promise<boolean> = new Promise((resolve, reject) => {
            updateResults.forEach(updateResult => {
                if (updateResult.has_error) {
                    logger.error('Error: %s, updating utterance: %s', updateResult.error, updateResult.utteranceText);
                    reject();
                }
            });
            resolve(true);
        });

        return checkUpdatePromise;
    }

    getUtterances(appId: string, page: number = 0): Promise<Luis.Utterance[]> {
        let utterancesPromise: Promise<Luis.Utterance[]> = new Promise((resolve, reject) => {
            this._luisClient.getUtterances(this._appId, page * this.PAGE_SIZE, this.PAGE_SIZE)
                .then(utterancesPage => {
                    if (utterancesPage.length === this.PAGE_SIZE) {
                        logger.debug('Page %s of utterances has been obtained', page + 1);
                        page = page + 1;
                        this.getUtterances(this._appId, page).then(moreUtterances => {
                            utterancesPage.forEach(utterance => {
                                moreUtterances.push(utterance);
                            });
                            resolve(moreUtterances);
                        });
                    } else {
                        logger.debug('All utterance obtained after %s pages', page + 1);
                        resolve(utterancesPage);
                    };
                })
                .catch((err) => {
                    logger.error(err, 'An error occurred while getting app utterances');
                    reject(err);
                });
        });
        return utterancesPromise;
    }

    deleteUtterances(staleUtterances: Luis.Utterance[], deletedUtterances: number = 0): Promise<number> {
        let deletePromise: Promise<number> = new Promise((resolve, reject) => {
            if (staleUtterances.length > 0) {
                let staleUtterance = staleUtterances.pop();
                this._luisClient.deleteUtterance(this._appId, staleUtterance)
                    .then(success => {
                        if (success) {
                            deletedUtterances = deletedUtterances + 1;
                        } else {
                            logger.debug('There was a problem deleting utterance %s', staleUtterance.text);
                            reject(deletedUtterances);
                        }
                        this.deleteUtterances(staleUtterances, deletedUtterances)
                            .then(deletedUtterances => {
                                resolve(deletedUtterances);
                            })
                            .catch(deletedUtterances => {
                                reject(deletedUtterances);
                            });
                    })
                    .catch(deletedUtterances => {
                        reject(deletedUtterances);
                    });
            } else {
                resolve(deletedUtterances);
            }
        });
        return deletePromise;
    }

    getStaleUtterances(appData: any, currentUtterances: Luis.Utterance[]): Luis.Utterance[] {
        let updatedUtterancesDict: { [id: string]: Luis.Utterance} = {};
        appData.utterances.forEach((updatedUtterance: Luis.Utterance) => {
            updatedUtterancesDict[updatedUtterance.text] = updatedUtterance;
        });
        let staleUtterances: Luis.Utterance[] = [];
        currentUtterances.forEach((currentUtterance: Luis.Utterance) => {
            if (!(currentUtterance.text in updatedUtterancesDict)) {
                //this utterance does not apply anymore and needs to be removed
                staleUtterances.push(currentUtterance);
            }
        });
        return staleUtterances;
    }

    waitForTraining(appId: string): Promise<boolean> {
        let trainingResult: Promise<boolean> = new Promise((resolve, reject) => {
            let failedModels: Luis.TrainingStatus[] = [];
            this._luisClient.getTrainingStatus(appId)
                .then(trainingStatuses => {
                    if (trainingStatuses.some(this.pendingTraining)) {
                        setTimeout(() => {
                            return this.waitForTraining(appId).then(failedModels => {
                                resolve(failedModels);
                            });
                        }, 2000);
                    } else {
                          trainingStatuses.forEach(trainingStatus => {
                            if (trainingStatus.details.status === 'Failed') {
                                logger.debug('Traning model %s failed. Error %s',
                                                trainingStatus.modelId,
                                                trainingStatus.details.failureReason);
                                failedModels.push(trainingStatus);
                            }
                          });
                          if (failedModels.length > 0) {
                              reject(failedModels);
                          } else {
                              resolve(true);
                          }
                    }
                })
                .catch((err) => {
                    logger.error(err, 'An error occurred while waiting for tranining to finish');
                    reject(err);
                });
        });
        return trainingResult;
    }

    pendingTraining(trainingStatus: Luis.TrainingStatus): boolean {
        return trainingStatus.details.status === 'In progress';
    }
}
