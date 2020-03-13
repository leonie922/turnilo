/*
 * Copyright 2015-2016 Imply Data, Inc.
 * Copyright 2017-2019 Allegro.pl
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as path from "path";
import { External } from "plywood";
import { PlywoodRequester } from "plywood-base-api";
import { DruidRequestDecorator } from "plywood-druid-requester";
import { Logger } from "../../../common/logger/logger";
import { Cluster } from "../../../common/models/cluster/cluster";
import { noop } from "../../../common/utils/functional/functional";
import { properRequesterFactory } from "../requester/requester";

const CONNECTION_RETRY_TIMEOUT = 20000;
const DRUID_REQUEST_DECORATOR_MODULE_VERSION = 1;

export interface RequestDecoratorFactoryParams {
  options: any;
  cluster: Cluster;
}

export interface DruidRequestDecoratorModule {
  version: number;
  druidRequestDecoratorFactory: (logger: Logger, params: RequestDecoratorFactoryParams) => DruidRequestDecorator;
}

// For each external we want to maintain its source and whether it should introspect at all
export interface ManagedExternal {
  name: string;
  external: External;
  autoDiscovered?: boolean;
  suppressIntrospection?: boolean;
}

export interface ClusterManagerOptions {
  logger: Logger;
  verbose?: boolean;
  anchorPath: string;
  initialExternals?: ManagedExternal[];
  onExternalChange?: (name: string, external: External) => Promise<void>;
  onExternalRemoved?: (name: string, external: External) => Promise<void>;
  generateExternalName?: (external: External) => string;
}

function emptyResolve(): Promise<void> {
  return Promise.resolve(null);
}

function getSourceFromExternal(external: External): string {
  return String(external.source);
}

export class ClusterManager {
  public logger: Logger;
  public verbose: boolean;
  public anchorPath: string;
  public cluster: Cluster;
  public initialConnectionEstablished: boolean;
  public introspectedSources: Record<string, boolean>;
  public version: string;
  public requester: PlywoodRequester<any>;
  public managedExternals: ManagedExternal[] = [];
  public onExternalChange: (name: string, external: External) => Promise<void>;
  public onExternalRemoved: (name: string, external: External) => Promise<void>;
  public generateExternalName: (external: External) => string;
  public requestDecoratorModule: DruidRequestDecoratorModule;

  private sourceListRefreshInterval = 0;
  private sourceListRefreshTimer: NodeJS.Timer = null;
  private sourceReintrospectInterval = 0;
  private sourceReintrospectTimer: NodeJS.Timer = null;

  private initialConnectionTimer: NodeJS.Timer = null;

  constructor(cluster: Cluster, options: ClusterManagerOptions) {
    if (!cluster) throw new Error("must have cluster");
    this.logger = options.logger;
    this.verbose = Boolean(options.verbose);
    this.anchorPath = options.anchorPath;
    this.cluster = cluster;
    this.initialConnectionEstablished = false;
    this.introspectedSources = {};
    this.version = cluster.version;
    this.managedExternals = options.initialExternals || [];
    this.onExternalChange = options.onExternalChange || emptyResolve;
    this.onExternalRemoved = options.onExternalRemoved || emptyResolve;
    this.generateExternalName = options.generateExternalName || getSourceFromExternal;

    this.updateRequestDecorator();
    this.updateRequester();

    this.managedExternals.forEach(managedExternal => {
      managedExternal.external = managedExternal.external.attachRequester(this.requester);
    });
  }

  // Do initialization
  public init(): Promise<void> {
    const { cluster, logger } = this;

    if (cluster.sourceListRefreshOnLoad) {
      logger.log(`Cluster '${cluster.name}' will refresh source list on load`);
    }

    if (cluster.sourceReintrospectOnLoad) {
      logger.log(`Cluster '${cluster.name}' will reintrospect sources on load`);
    }

    return this.establishInitialConnection()
      .then(() => this.introspectSources())
      .then(() => this.scanSourceList());
  }

  public destroy() {
    if (this.sourceListRefreshTimer) {
      clearInterval(this.sourceListRefreshTimer);
      this.sourceListRefreshTimer = null;
    }
    if (this.sourceReintrospectTimer) {
      clearInterval(this.sourceReintrospectTimer);
      this.sourceReintrospectTimer = null;
    }
    if (this.initialConnectionTimer) {
      clearTimeout(this.initialConnectionTimer);
      this.initialConnectionTimer = null;
    }
  }

  private addManagedExternal(managedExternal: ManagedExternal): Promise<void> {
    this.managedExternals.push(managedExternal);
    return this.onExternalChange(managedExternal.name, managedExternal.external);
  }

  private updateManagedExternal(managedExternal: ManagedExternal, newExternal: External): Promise<void> {
    if (managedExternal.external.equals(newExternal)) return null;
    managedExternal.external = newExternal;
    return this.onExternalChange(managedExternal.name, managedExternal.external);
  }

  private removeManagedExternal(managedExternal: ManagedExternal): Promise<void> {
    this.managedExternals = this.managedExternals.filter(ext => ext.external !== managedExternal.external);
    return this.onExternalRemoved(managedExternal.name, managedExternal.external);
  }

  private updateRequestDecorator(): void {
    const { cluster, logger, anchorPath } = this;
    if (!cluster.requestDecorator) return;

    var requestDecoratorPath = path.resolve(anchorPath, cluster.requestDecorator);
    logger.log(`Loading requestDecorator from '${requestDecoratorPath}'`);
    try {
      this.requestDecoratorModule = require(requestDecoratorPath);
    } catch (e) {
      throw new Error(`error loading druidRequestDecorator module from '${requestDecoratorPath}': ${e.message}`);
    }

    if (this.requestDecoratorModule.version !== DRUID_REQUEST_DECORATOR_MODULE_VERSION) {
      throw new Error(`druidRequestDecorator module '${requestDecoratorPath}' has incorrect version`);
    }
  }

  private updateRequester() {
    const { cluster, logger, requestDecoratorModule } = this;

    var druidRequestDecorator: DruidRequestDecorator = null;
    if (cluster.type === "druid" && requestDecoratorModule) {
      logger.log(`Cluster '${cluster.name}' creating requestDecorator`);
      druidRequestDecorator = requestDecoratorModule.druidRequestDecoratorFactory(logger, {
        options: cluster.decoratorOptions,
        cluster
      });
    }

    this.requester = properRequesterFactory({
      cluster,
      verbose: this.verbose,
      concurrentLimit: 5,
      druidRequestDecorator
    });
  }

  private updateSourceListRefreshTimer() {
    const { logger, cluster } = this;

    if (this.sourceListRefreshInterval !== cluster.getSourceListRefreshInterval()) {
      this.sourceListRefreshInterval = cluster.getSourceListRefreshInterval();

      if (this.sourceListRefreshTimer) {
        logger.log(`Clearing sourceListRefresh timer in cluster '${cluster.name}'`);
        clearInterval(this.sourceListRefreshTimer);
        this.sourceListRefreshTimer = null;
      }

      if (this.sourceListRefreshInterval && cluster.shouldScanSources()) {
        logger.log(`Setting up sourceListRefresh timer in cluster '${cluster.name}' (every ${this.sourceListRefreshInterval}ms)`);
        this.sourceListRefreshTimer = setInterval(
          () => {
            this.scanSourceList().catch(e => {
              logger.error(`Cluster '${cluster.name}' encountered and error during SourceListRefresh: ${e.message}`);
            });
          },
          this.sourceListRefreshInterval
        );
        this.sourceListRefreshTimer.unref();
      }
    }
  }

  private updateSourceReintrospectTimer() {
    const { logger, cluster } = this;

    if (this.sourceReintrospectInterval !== cluster.getSourceReintrospectInterval()) {
      this.sourceReintrospectInterval = cluster.getSourceReintrospectInterval();

      if (this.sourceReintrospectTimer) {
        logger.log(`Clearing sourceReintrospect timer in cluster '${cluster.name}'`);
        clearInterval(this.sourceReintrospectTimer);
        this.sourceReintrospectTimer = null;
      }

      if (this.sourceReintrospectInterval) {
        logger.log(`Setting up sourceReintrospect timer in cluster '${cluster.name}' (every ${this.sourceReintrospectInterval}ms)`);
        this.sourceReintrospectTimer = setInterval(
          () => {
            this.introspectSources().catch(e => {
              logger.error(`Cluster '${cluster.name}' encountered and error during SourceReintrospect: ${e.message}`);
            });
          },
          this.sourceReintrospectInterval
        );
        this.sourceReintrospectTimer.unref();
      }
    }
  }

  private establishInitialConnection(): Promise<void> {
    const { logger, verbose, cluster } = this;

    return new Promise<void>(resolve => {
      let retryNumber = -1;
      let lastTryAt: number;

      const attemptConnection = () => {
        retryNumber++;
        if (retryNumber === 0) {
          if (verbose) logger.log(`Attempting to connect to cluster '${cluster.name}'`);
        } else {
          logger.log(`Re-attempting to connect to cluster '${cluster.name}' (retry ${retryNumber})`);
        }
        lastTryAt = Date.now();
        (External.getConstructorFor(cluster.type) as any)
          .getVersion(this.requester)
          .then(
            (version: string) => {
              this.onConnectionEstablished();
              this.internalizeVersion(version).then(() => resolve(null));
            },
            (e: Error) => {
              const msSinceLastTry = Date.now() - lastTryAt;
              const msToWait = Math.max(1, CONNECTION_RETRY_TIMEOUT - msSinceLastTry);
              logger.error(`Failed to connect to cluster '${cluster.name}' because: ${e.message} (will retry in ${msToWait}ms)`);
              this.initialConnectionTimer = setTimeout(attemptConnection, msToWait);
            }
          );
      };

      attemptConnection();
    });
  }

  private onConnectionEstablished(): void {
    const { logger, cluster } = this;
    logger.log(`Connected to cluster '${cluster.name}'`);
    this.initialConnectionEstablished = true;

    this.updateSourceListRefreshTimer();
    this.updateSourceReintrospectTimer();
  }

  private internalizeVersion(version: string): Promise<void> {
    // If there is a version already do nothing
    if (this.version) return Promise.resolve(null);

    const { logger, cluster } = this;
    logger.log(`Cluster '${cluster.name}' is running druid@${version}`);
    this.version = version;

    // Update all externals if needed
    const tasks: Array<Promise<void>> = this.managedExternals.map(managedExternal => {
      if (managedExternal.external.version) return Promise.resolve(null);
      return this.updateManagedExternal(managedExternal, managedExternal.external.changeVersion(version));
    });
    return Promise.all(tasks).then(noop);
  }

  private introspectManagedExternal(managedExternal: ManagedExternal): Promise<void> {
    const { logger, verbose, cluster } = this;
    if (managedExternal.suppressIntrospection) return Promise.resolve(null);

    if (verbose) logger.log(`Cluster '${cluster.name}' introspecting '${managedExternal.name}'`);
    return managedExternal.external.introspect()
      .then(
        introspectedExternal => {
          this.introspectedSources[String(introspectedExternal.source)] = true;
          return this.updateManagedExternal(managedExternal, introspectedExternal);
        },
        (e: Error) => {
          logger.error(`Cluster '${cluster.name}' could not introspect '${managedExternal.name}' because: ${e.message}`);
        }
      );
  }

  // See if any new sources were added to the cluster
  public scanSourceList = (): Promise<void> => {
    const { logger, cluster, verbose } = this;
    if (!cluster.shouldScanSources()) return Promise.resolve(null);

    logger.log(`Scanning cluster '${cluster.name}' for new sources`);
    return (External.getConstructorFor(cluster.type) as any).getSourceList(this.requester)
      .then(
        (sources: string[]) => {
          if (verbose) logger.log(`For cluster '${cluster.name}' got sources: [${sources.join(", ")}]`);
          // For every un-accounted source: make an external and add it to the managed list.
          let introspectionTasks: Array<Promise<void>> = [];

          this.managedExternals.forEach(ex => {
            if (sources.find(src => src === String(ex.external.source)) == null) {
              logger.log(`Missing source '${String(ex.external.source)}' + " for cluster '${cluster.name}', removing...`);
              introspectionTasks.push(this.removeManagedExternal(ex));
            }
          });

          sources.forEach(source => {
            const existingExternalsForSource = this.managedExternals.filter(managedExternal => getSourceFromExternal(managedExternal.external) === source);

            if (existingExternalsForSource.length) {
              if (verbose) logger.log(`Cluster '${cluster.name}' already has an external for '${source}' ('${existingExternalsForSource[0].name}')`);
              if (!this.introspectedSources[source]) {
                // If this source has never been introspected introspect all of its externals
                logger.log(`Cluster '${cluster.name}' has never seen '${source}' and will introspect '${existingExternalsForSource[0].name}'`);
                existingExternalsForSource.forEach(existingExternalForSource => {
                  introspectionTasks.push(this.introspectManagedExternal(existingExternalForSource));
                });
              }

            } else {
              logger.log(`Cluster '${cluster.name}' making external for '${source}'`);
              const external = cluster.makeExternalFromSourceName(source, this.version).attachRequester(this.requester);
              const newManagedExternal: ManagedExternal = {
                name: this.generateExternalName(external),
                external,
                autoDiscovered: true
              };
              introspectionTasks.push(
                this.addManagedExternal(newManagedExternal)
                  .then(() => this.introspectManagedExternal(newManagedExternal))
              );

            }
          });

          return Promise.all(introspectionTasks);
        },
        (e: Error) => {
          logger.error(`Failed to get source list from cluster '${cluster.name}' because: ${e.message}`);
        }
      );
  }

  // See if any new dimensions or measures were added to the existing externals
  public introspectSources = (): Promise<void> => {
    const { logger, cluster } = this;

    logger.log(`Introspecting all sources in cluster '${cluster.name}'`);

    return (External.getConstructorFor(cluster.type) as any).getSourceList(this.requester)
        .then(
            (sources: string[]) => {
              let introspectionTasks: Array<Promise<void>> = [];
              sources.forEach(source => {
                const existingExternalsForSource = this.managedExternals.filter(managedExternal => getSourceFromExternal(managedExternal.external) === source);

                if (existingExternalsForSource.length) {
                  existingExternalsForSource.forEach(existingExternalForSource => {
                    introspectionTasks.push(this.introspectManagedExternal(existingExternalForSource));
                  });
                }
              });
              return Promise.all(introspectionTasks);
            },
            (e: Error) => {
              logger.error(`Failed to get source list from cluster '${cluster.name}' because: ${e.message}`);
            }
        );
  }

  // Refresh the cluster now, will trigger onExternalUpdate and then return an empty promise when done
  public refresh(): Promise<void> {
    const { cluster, initialConnectionEstablished } = this;
    let process = Promise.resolve(null);
    if (!initialConnectionEstablished) return process;

    if (cluster.sourceReintrospectOnLoad) {
      process = process.then(() => this.introspectSources());
    }

    if (cluster.sourceListRefreshOnLoad) {
      process = process.then(() => this.scanSourceList());
    }

    return process;
  }

}
