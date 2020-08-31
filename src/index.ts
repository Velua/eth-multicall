import Web3 from "web3";
import { ABIMultiCallContract } from "./abi";
import { chunk, mapValues, zip, isNumber, omit, toPairs } from "lodash";
import { createIndexSet, mergeFromIndexSet } from "./helpers";

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
  call: () => Promise<T>;
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
    strict: boolean = false
  ): Promise<MultiCallReturn[]> {
    const multiContract = new this.web3.eth.Contract(
      ABIMultiCallContract,
      this.contract
    );

    try {
      const res = await multiContract.methods.aggregate(calls, strict).call();

      const matched = zip(
        calls.map(([address]) => address),
        res.returnData
      ) as MultiCallReturn[];
      console.log("Multisuccess", calls.length, "requests");
      return matched;
    } catch (e) {
      console.warn("MultiFailure", calls.length, "requests");
      throw new Error(e);
    }
  }

  async multiCallGroups(calls: MultiCallItem[][]) {
    if (calls.length == 0) return [];
    const indexes = createIndexSet(calls);
    const flatCalls = calls.flat(1);

    const res = await this.rawCallInChunks(flatCalls, this.chunkSizes);
    return mergeFromIndexSet(res, indexes);
  }

  async rawCallInChunks(
    calls: MultiCallItem[],
    chunkSizes: number[]
  ): Promise<MultiCallReturn[]> {
    const chunks = chunk(calls, chunkSizes[0]);

    const res = await Promise.all(
      chunks.map(async (chunk) => {
        const requests = chunk;
        try {
          const result = await this.rawCall(chunk, false);
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
    if (allFulfilled) {
      return res.flatMap((x) => x.result!);
    } else {
      const working = await Promise.all(
        res.map(async (res) => {
          if (res.success) {
            return res.result!;
          }
          const newChunkSize = chunkSizes.slice(1);
          if (newChunkSize.length == 0)
            throw new Error(`Failed request ${res.error}`);
          return this.rawCallInChunks(res.requests, newChunkSize);
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

  private objToArray<T>(obj: {
    [item: string]: T;
  }): { key: string; value: T }[] {
    return Object.keys(obj).map((key) => ({ key, value: obj[key] }));
  }

  async all(groupsOfShapes: ShapeWithLabel[][], skipDecode = false) {
    const plainShapes = this.stripLabels(groupsOfShapes);
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
    const res = await this.multiCallGroups(multiCalls);

    const rebuiltRes = mergeFromIndexSet(res, groupsIndexSet);

    const answer = zip(plainShapes, rebuiltRes);
    const better = answer.map(([abi, res]) => zip(abi, res));
    const rawMatch = better.map((group) =>
      group.map(([shape, resultsArr]) =>
        zip(this.objToArray(shape), resultsArr)
      )
    );
    const withOrigin = rawMatch.map((group) =>
      group.map((keys) => {
        return keys.reduce((acc, [keyAbi, [origin, { success, data }]]) => {
          const callReturn = keyAbi.value as CallReturn<any>;

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
            [keyAbi.key]: result,
          };
        }, {} as { [key: string]: string | undefined; _originAddress: string });
      })
    );

    const nameRecall = zip(groupsOfShapes, withOrigin);
    const renamed = nameRecall.map(([plainShape, withOrigin]) => {
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
        return omit(keysAdded, originAddressKey);
      });
    });

    return renamed;
  }
}
