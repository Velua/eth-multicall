import Web3 from "web3";
import { ABIMultiCallContract } from "./abi";
import {
  chunk,
  mapValues,
  zip,
  isNumber,
  omit,
  toPairs,
  fromPairs,
} from "lodash";
import {
  createIndexSet,
  mergeFromIndexSet,
  removeOverSizedChunks,
} from "./helpers";

export interface Options {
  web3: Web3;
  chunkSizes?: number[];
  multiCallContract: string;
  strict: boolean;
}

export interface CallReturn<T = any> {
  arguments: any[];
  _method: {
    outputs: { name: string; type: string }[];
  };
  _parent: {
    _address: string;
  };
  call: (options?: {}, blockHeight?: number) => Promise<T>;
  encodeABI: () => string;
}

export type MultiCallItem = [string, string];
export type MultiCallReturn = [string, { success: boolean; data: string }];
export interface ShapeWithLabel {
  [item: string]: CallReturn | string;
}

export interface Shape {
  [item: string]: CallReturn;
}

export interface AbiEncodedShape {
  originAddress: string;
  data: {
    [item: string]: string;
  };
}

export enum DataTypes {
  originAddress = "originAddress",
}

interface CallOptions {
  skipDecode: boolean;
  traditional: boolean;
  blockHeight?: number;
}

export interface UserCallOptions {
  skipDecode?: boolean;
  traditional?: boolean;
  blockHeight?: number;
}

export class MultiCall {
  constructor(
    public web3: Web3,
    public contract: string = "0x5Eb3fa2DFECdDe21C950813C665E9364fa609bD2",
    public chunkSizes: number[] = [300, 100, 25]
  ) {
    const isNumbersAndAtLeastOne =
      chunkSizes.every((number) => isNumber(number)) && chunkSizes.length > 0;
    if (!isNumbersAndAtLeastOne)
      throw new Error("Chunk sizes must be numbers and at least one");
  }

  async rawCall(
    calls: MultiCallItem[],
    strict: boolean = false,
    blockHeight?: number
  ): Promise<MultiCallReturn[]> {
    const multiContract = new this.web3.eth.Contract(
      ABIMultiCallContract,
      this.contract
    );

    try {
      const callArgs = blockHeight ? [null, blockHeight] : [];

      const res = await multiContract.methods
        .aggregate(calls, strict)
        .call(...callArgs);

      const matched = zip(
        calls.map(([address]) => address),
        res.returnData
      ) as MultiCallReturn[];
      return matched;
    } catch (e) {
      throw new Error(e);
    }
  }

  async multiCallGroups(calls: MultiCallItem[][], blockHeight?: number) {
    if (calls.length == 0) return [];
    const indexes = createIndexSet(calls);
    const flatCalls = calls.flat(1);

    const res = await this.rawCallInChunks(
      flatCalls,
      this.chunkSizes,
      blockHeight
    );
    return mergeFromIndexSet(res, indexes);
  }

  async rawCallInChunks(
    calls: MultiCallItem[],
    chunkSizes: number[],
    blockHeight?: number
  ): Promise<MultiCallReturn[]> {
    const chunksNoBiggerThanRequests = removeOverSizedChunks(
      calls.length,
      chunkSizes
    );
    const chunks = chunk(calls, chunksNoBiggerThanRequests[0]);

    const res = await Promise.all(
      chunks.map(async (chunk) => {
        const requests = chunk;
        try {
          const result = await this.rawCall(chunk, false, blockHeight);
          return {
            success: true,
            requests,
            result,
          };
        } catch (e) {
          return {
            success: false,
            requests,
            error: e.message,
          };
        }
      })
    );

    const allFulfilled = res.every((res) => res.success);
    const allFailedAndLastChunk =
      chunksNoBiggerThanRequests.length == 1 &&
      res.every((res) => !res.success);

    if (allFulfilled) {
      return res.flatMap((x) => x.result!);
    } else if (allFailedAndLastChunk) {
      throw new Error(`All requests failed on last chunk ${res[0].error}`);
    } else {
      const working = await Promise.all(
        res.map(async (res) => {
          if (res.success) {
            return res.result!;
          }
          const newChunkSize = chunksNoBiggerThanRequests.slice(1);
          if (newChunkSize.length == 0)
            throw new Error(`Failed request ${res.error}`);
          return this.rawCallInChunks(res.requests, newChunkSize, blockHeight);
        })
      );
      return working.flat(1);
    }
  }

  private decodeHex(hex: string, type: string | any[]) {
    const typeIsArray = Array.isArray(type);
    try {
      if (typeIsArray) {
        return this.web3.eth.abi.decodeParameters(type as any[], hex);
      } else {
        return this.web3.eth.abi.decodeParameter(type as string, hex);
      }
    } catch (e) {
      return undefined;
    }
  }

  private async normalCall(groupsOfShapes: Shape[][], blockHeight?: number) {
    return Promise.all(
      groupsOfShapes.map(async (group) =>
        Promise.all(
          group.map(async (shape) => {
            const originAddresses = Object.values(shape).map(
              (abi) => abi._parent._address
            );

            const firstOriginAddress = originAddresses[0];

            const sameOriginAddress = originAddresses.every(
              (address) => address == firstOriginAddress
            );

            if (!sameOriginAddress)
              throw new Error("Shape group must have the same origin address");

            const callArgs = blockHeight ? [null, blockHeight] : [];
            return {
              _originAddress: firstOriginAddress,
              data: fromPairs(
                await Promise.all(
                  toPairs(shape).map(async ([label, abi]) => [
                    label,
                    await abi.call(...callArgs).catch(() => {}),
                  ])
                )
              ),
            };
          })
        )
      )
    );
  }

  private encodeAbi(groupsOfShapes: Shape[][]): AbiEncodedShape[][] {
    return groupsOfShapes.map((group) =>
      group.map((shape) => {
        const originAddresses = Object.values(shape).map(
          (abi) => abi._parent._address
        );

        const sameOriginAddress = originAddresses.every(
          (address, index, arr) => address === arr[0]
        );

        if (!sameOriginAddress)
          throw new Error("Shape group must have the same origin address");
        const originAddress = originAddresses[0];

        return {
          originAddress,
          data: mapValues(shape, (abi) => abi.encodeABI()),
        };
      })
    );
  }

  stripLabels(groupsOfShapes: ShapeWithLabel[][]): Shape[][] {
    return groupsOfShapes.map((group) =>
      group.map((relay) => {
        const pairs = toPairs(relay);
        const keysToRemove = pairs
          .filter(([key, value]) => typeof value == "string")
          .map(([key]) => key);
        return omit(relay, keysToRemove) as Shape;
      })
    );
  }

  recoverLabels(original: ShapeWithLabel[][], withData: any[][]) {
    const nameRecall = zip(original, withData);

    const toReturn = nameRecall.map(([plainShape, withOrigin]) => {
      const zipped = zip(plainShape, withOrigin);
      return zipped.map(([plain, origin]) => {
        const originAddressKey = "_originAddress";
        const originAddress = origin[originAddressKey];
        const keysToAdd = toPairs(plain)
          .filter(([key, value]) => typeof value == "string")
          .map(([key, value]) => [
            key,
            value == DataTypes.originAddress
              ? originAddress
              : (value as string),
          ]);
        const keysAdded = keysToAdd.reduce(
          (acc, [key, value]) => ({
            ...acc,
            [key]: value,
          }),
          origin
        );
        const big = omit(keysAdded, originAddressKey);

        const noData = omit(big, "data");
        return {
          ...noData,
          ...big.data,
        };
      });
    });

    return toReturn;
  }

  async all(
    groupsOfShapes: ShapeWithLabel[][],
    passedOptions?: UserCallOptions
  ) {
    const flattenedAmount = groupsOfShapes.flat(9).length;
    if (flattenedAmount == 0) return groupsOfShapes;
    const defaultOptions: CallOptions = {
      skipDecode: false,
      traditional: false,
      blockHeight: undefined,
    };
    const options: CallOptions = {
      ...defaultOptions,
      ...passedOptions,
    };

    const { skipDecode, traditional, blockHeight } = options;
    const plainShapes = this.stripLabels(groupsOfShapes);

    if (traditional) {
      const normalEncoded = await this.normalCall(plainShapes, blockHeight);
      const flattened = normalEncoded.flat(2);
      const propertiesCount = flattened.reduce(
        (acc, item) => Object.keys(item.data).length + acc,
        0
      );
      return this.recoverLabels(groupsOfShapes, normalEncoded);
    }

    const abiEncodedGroups = this.encodeAbi(plainShapes);
    const groupsIndexSet = createIndexSet(groupsOfShapes);
    const multiCalls = abiEncodedGroups.flatMap((encodedGroup) =>
      encodedGroup.map((group) =>
        Object.values(group.data).map(
          (encodedString) =>
            [group.originAddress, encodedString] as MultiCallItem
        )
      )
    );
    const res = await this.multiCallGroups(multiCalls, blockHeight);

    const rebuiltRes = mergeFromIndexSet(res, groupsIndexSet);

    const answer = zip(plainShapes, rebuiltRes);
    const better = answer.map(([abi, res]) => zip(abi, res));
    const rawMatch = better.map((group) =>
      group.map(([shape, resultsArr]) => zip(toPairs(shape), resultsArr))
    );
    const withOrigin = rawMatch.map((group) =>
      group.map((keys) => {
        return keys.reduce(
          (acc, [[key, value], [origin, { success, data }]]) => {
            const callReturn = value;

            const result = skipDecode
              ? data
              : success
              ? this.decodeHex(
                  data,
                  callReturn._method.outputs.length == 1
                    ? callReturn._method.outputs[0].type
                    : callReturn._method.outputs.map((x) => x.type)
                )
              : undefined;

            return {
              ...acc,
              _originAddress: origin,
              [key]: result,
            };
          },
          {} as { [key: string]: string | undefined; _originAddress: string }
        );
      })
    );

    const renamed = this.recoverLabels(groupsOfShapes, withOrigin);

    return renamed;
  }
}
