import { Mutex, MutexInterface, withTimeout } from 'async-mutex';
import * as TE from 'fp-ts/TaskEither';
import { TaskEither } from 'fp-ts/TaskEither';
import { match as fpMatch } from 'fp-ts/boolean';
import { constVoid, pipe } from 'fp-ts/lib/function';
import AlexaRemote, {
  type CallbackWithErrorAndBody,
  type EntityType,
  type MessageCommands,
} from '../alexa-remote.js';
import { SupportedActionsType } from '../domain/alexa';
import { AlexaApiError, HttpError, TimeoutError } from '../domain/alexa/errors';
import GetDeviceStatesResponse, {
  ValidCapabilityStates,
  ValidStatesByDevice,
  extractCapabilityStates,
  validateGetStatesSuccessful,
} from '../domain/alexa/get-device-states';
import GetDevicesResponse, {
  SmartHomeDevice,
  validateGetDevicesSuccessful,
} from '../domain/alexa/get-devices';
import GetPlayerInfoResponse, {
  PlayerInfo,
  validateGetPlayerInfoSuccessful,
} from '../domain/alexa/get-player-info';
import GetDetailsForDevicesResponse, {
  extractEntityIdBySkill,
  extractRangeCapabilities,
} from '../domain/alexa/save-device-capabilities';
import SetDeviceStateResponse, {
  validateSetStateSuccessful,
} from '../domain/alexa/set-device-state';
import DeviceStore from '../store/device-store';
import { PluginLogger } from '../util/plugin-logger';

export interface DeviceStatesCache {
  lastUpdated: Date;
  cachedStates: ValidStatesByDevice;
}

export class AlexaApiWrapper {
  private readonly mutex: MutexInterface;
  public skillFilterDeviceIds: string[] = [];

  constructor(
    private readonly alexaRemote: AlexaRemote,
    private readonly log: PluginLogger,
    private readonly deviceStore: DeviceStore,
  ) {
    this.mutex = withTimeout(
      new Mutex(new TimeoutError('Alexa API Timeout')),
      65_000,
    );
  }

  getDevices(): TaskEither<AlexaApiError, SmartHomeDevice[]> {
    return pipe(
      TE.tryCatch(
        () =>
          AlexaApiWrapper.toPromise<GetDevicesResponse>(
            this.alexaRemote.getSmarthomeEntities.bind(this.alexaRemote),
          ),
        (reason) =>
          new HttpError(
            `Error getting smart home devices. Reason: ${
              (reason as Error).message
            }`,
          ),
      ),
      TE.flatMapEither(validateGetDevicesSuccessful),
    );
  }

  retrieveEntityIdsBySkill(): TaskEither<AlexaApiError, string[]> {
    // eslint-disable-next-line no-console
    return pipe(
      TE.tryCatch(
        () =>
          AlexaApiWrapper.toPromise<GetDetailsForDevicesResponse>(
            this.alexaRemote.getSmarthomeDevices.bind(this.alexaRemote),
          ),
        (reason) =>
          new HttpError(
            `Error getting details for devices. Reason: ${
              (reason as Error).message
            }`,
          ),
      ),
      TE.map(extractEntityIdBySkill),
      TE.tapIO((response) =>
        this.log.debug(
          'BEGIN EntityIdBySkill:',
          JSON.stringify(response, undefined, 2),
          '\nEND EntityIdBySkill',
        ),
      ),
      TE.map((data) => {
        const targetKey =
          // eslint-disable-next-line max-len
          /eyJza2lsbElkIjoiYW16bjEuYXNrLnNraWxsLmEyOGM0M2UxLWNiYTYtNGFhYy05M2NhLTUwOWU4YzdjZTM5YiIsInN0YWdlIjoiZGV2ZWxvcG1lbnQifQ==|eyJza2lsbElkIjoiYW16bjEuYXNrLnNraWxsLjJhZjAwOGJiLTJiYjAtNGJlZi1iMTMxLWUxOTFmOTQ0YTg3ZSIsInN0YWdlIjoibGl2ZSJ9/;
        // Test Skill | Production skill
        const entityIds: string[] = [];

        for (const key in data) {
          if (targetKey.test(key)) {
            const entities = data[key];
            for (const entity of entities) {
              entityIds.push(entity.entityId);
            }
          }
        }
        this.skillFilterDeviceIds = entityIds;
        return entityIds;
      }),
    );
  }

  saveDeviceCapabilities(): TaskEither<AlexaApiError, void> {
    return pipe(
      TE.tryCatch(
        () =>
          AlexaApiWrapper.toPromise<GetDetailsForDevicesResponse>(
            this.alexaRemote.getSmarthomeDevices.bind(this.alexaRemote),
          ),
        (reason) =>
          new HttpError(
            `Error getting details for devices. Reason: ${
              (reason as Error).message
            }`,
          ),
      ),
      TE.tapIO((response) =>
        this.log.debug(
          'BEGIN capabilities for all devices:',
          JSON.stringify(response, undefined, 2),
          'END capabilities for all devices',
        ),
      ),
      TE.map(extractRangeCapabilities),
      TE.map((rc) => {
        this.deviceStore.deviceCapabilities = rc;
      }),
    );
  }

  getDeviceStates(
    deviceIds: string[],
    entityType: EntityType | 'ENTITY' = 'ENTITY',
    useCache = true,
  ): TaskEither<AlexaApiError, ValidCapabilityStates> {
    const shouldReturnCache = () =>
      useCache &&
      this.deviceStore.isCacheFresh() &&
      this.doesCacheContainAllIds(
        Object.keys(this.deviceStore.cache.states),
        deviceIds,
      );

    return pipe(
      TE.tryCatch(
        () => this.mutex.acquire(),
        (e) => e as TimeoutError,
      ),
      TE.map(shouldReturnCache),
      TE.flatMap(
        fpMatch(
          () =>
            pipe(
              TE.of(deviceIds),
              TE.tapIO(() => this.log.debug('Updating device states')),
              TE.flatMap((entityIds) =>
                this.queryDeviceStates(entityIds, entityType),
              ),
              TE.flatMapEither(validateGetStatesSuccessful),
              TE.map(extractCapabilityStates),
              TE.map(
                ({ statesByDevice }) =>
                  ({
                    statesByDevice: this.deviceStore.updateCache(
                      deviceIds,
                      statesByDevice,
                    ),
                    fromCache: false,
                  } as ValidCapabilityStates),
              ),
            ),
          () =>
            pipe(
              TE.of({
                fromCache: true,
                statesByDevice: this.deviceStore.cache.states,
              } as ValidCapabilityStates),
              TE.tapIO(() =>
                this.log.debug('Obtained device states from cache'),
              ),
            ),
        ),
      ),
      TE.mapBoth(
        (e) => {
          this.mutex.release();
          return e;
        },
        (res) => {
          this.mutex.release();
          return res;
        },
      ),
    );
  }

  setDeviceState(
    deviceId: string,
    action: SupportedActionsType,
    parameters: Record<string, string> = {},
    entityType: EntityType = 'APPLIANCE',
  ): TaskEither<AlexaApiError, void> {
    return pipe(
      TE.tryCatch(
        () =>
          this.changeDeviceState(
            deviceId,
            { action, ...parameters },
            entityType,
          ),
        (reason) =>
          new HttpError(
            `Error setting smart home device state. Reason: ${
              (reason as Error).message
            }`,
          ),
      ),
      TE.flatMapEither(validateSetStateSuccessful),
      TE.map(constVoid),
    );
  }

  getPlayerInfo(deviceName: string): TaskEither<AlexaApiError, PlayerInfo> {
    return pipe(
      TE.tryCatch(
        () =>
          AlexaApiWrapper.toPromise<GetPlayerInfoResponse>(
            this.alexaRemote.getPlayerInfo.bind(this.alexaRemote, deviceName),
          ),
        (reason) =>
          new HttpError(
            `Error getting media player information. Reason: ${
              (reason as Error).message
            }`,
          ),
      ),
      TE.flatMapEither(validateGetPlayerInfoSuccessful),
    );
  }

  setVolume(
    deviceName: string,
    volume: number,
  ): TaskEither<AlexaApiError, void> {
    return pipe(
      TE.tryCatch(
        () =>
          AlexaApiWrapper.toPromise<void>(
            this.alexaRemote.sendMessage.bind(
              this.alexaRemote,
              deviceName,
              'volume',
              volume,
            ),
          ),
        (reason) =>
          new HttpError(
            `Error setting volume. Reason: ${(reason as Error).message}`,
          ),
      ),
    );
  }

  controlMedia(
    deviceName: string,
    command: MessageCommands,
  ): TaskEither<AlexaApiError, void> {
    return pipe(
      TE.tryCatch(
        () =>
          AlexaApiWrapper.toPromise<void>(
            this.alexaRemote.sendMessage.bind(
              this.alexaRemote,
              deviceName,
              command,
              false,
            ),
          ),
        (reason) =>
          new HttpError(
            `Error sending ${command} command to media player. Reason: ${
              (reason as Error).message
            }`,
          ),
      ),
    );
  }

  private changeDeviceState(
    entityId: string,
    parameters: Record<string, string>,
    entityType: EntityType = 'APPLIANCE',
  ): Promise<SetDeviceStateResponse> {
    return AlexaApiWrapper.toPromise<SetDeviceStateResponse>(
      this.alexaRemote.executeSmarthomeDeviceAction.bind(
        this.alexaRemote,
        [entityId],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        parameters as any,
        entityType,
      ),
    );
  }

  private static async toPromise<T>(
    fn: (cb: CallbackWithErrorAndBody) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) =>
      fn((error, body) =>
        pipe(
          !!error,
          fpMatch(
            () => resolve(body as T),
            () => reject(error),
          ),
        ),
      ),
    );
  }

  private queryDeviceStates(
    entityIds: string[],
    entityType: string,
  ): TE.TaskEither<HttpError, GetDeviceStatesResponse> {
    return TE.tryCatch(
      () =>
        AlexaApiWrapper.toPromise<GetDeviceStatesResponse>(
          this.alexaRemote.querySmarthomeDevices.bind(
            this.alexaRemote,
            entityIds,
            entityType as EntityType,
          ),
        ),
      (reason) =>
        new HttpError(
          `Error getting smart home device state. Reason: ${
            (reason as Error).message
          }`,
        ),
    );
  }

  private doesCacheContainAllIds = (cachedIds: string[], queryIds: string[]) =>
    queryIds.every((id) => {
      return cachedIds.includes(id);
    });
}
