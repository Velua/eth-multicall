require("dotenv").config();
import Web3 from "web3";
import {
  createIndexSet,
  mergeFromIndexSet,
  indexSet,
  removeOverSizedChunks,
} from "../src/helpers";
import { MultiCall, MultiCallItem } from "../src/index";
import { ABISmartToken, ABIConverterV28 } from "../abis";

describe("index set works as expected", () => {
  const data = [
    [1, 2, 3],
    [1, 2, 3, 4],
  ];

  const expectedIndexSet = [
    [0, 3],
    [3, 7],
  ] as indexSet[];

  test("can create an index set", () => {
    const base = createIndexSet(data);
    expect(base).toStrictEqual(expectedIndexSet);
  });

  test("can rebuild from an index set", () => {
    const indexSet = createIndexSet(data);
    // @ts-ignore
    const flat = data.flat(1);
    expect(mergeFromIndexSet(flat, indexSet)).toStrictEqual(data);
  });
});

const INFURA_KEY = process.env.INFURA_KEY;

const web3 = new Web3(`https://mainnet.infura.io/v3/${INFURA_KEY}`);
const ropstenWeb3 = new Web3(`https://ropsten.infura.io/v3/${INFURA_KEY}`);

const HELLOWORLD = "HELLOWORLD";

describe("can pull data", () => {
  test("response is the same when using chunks and flat calls", async () => {
    const multiCall = new MultiCall(
      web3,
      "0x5Eb3fa2DFECdDe21C950813C665E9364fa609bD2"
    );
    const rawCalls: MultiCallItem[] = [
      ["0x960b236A07cf122663c4303350609A66A7B288C0", "0x95d89b41"],
      ["0x960b236A07cf122663c4303350609A66A7B288C0", "0x313ce567"],
      ["0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C", "0x95d89b41"],
      ["0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C", "0x313ce567"],
      ["0xE870D00176b2C71AFD4c43ceA550228E22be4ABd", "0x71f52bf3"],
      ["0xca5d7661a4D9f1D3954E64664d8710fDc4FaA5b7", "0x71f52bf3"],
    ];

    const moreCalls = [...rawCalls, ...rawCalls, ...rawCalls];

    const callsToCompare = moreCalls;

    const res = await multiCall.rawCall(callsToCompare, false);
    const chunkedCalls = await multiCall.rawCallInChunks(callsToCompare, [
      4,
      1,
      1,
      1,
      1,
    ]);

    expect(res).toStrictEqual(chunkedCalls);
  });

  test("returns expected pool and token information", async () => {
    const addresses = [
      "0x960b236A07cf122663c4303350609A66A7B288C0",
      "0x1f573d6fb3f13d689ff844b4ce37794d79a7ff1c",
    ];

    const tokens = addresses.map((x) => {
      const token = new web3.eth.Contract(ABISmartToken, x);
      return {
        tokenAddress: "originAddress",
        symbol: token.methods.symbol(),
        decimals: token.methods.decimals(),
        randomMeta: HELLOWORLD,
      };
    });

    const converterAddresses = [
      "0xE870D00176b2C71AFD4c43ceA550228E22be4ABd",
      "0xca5d7661a4D9f1D3954E64664d8710fDc4FaA5b7",
    ];

    const converters = converterAddresses.map((address) => {
      const converterContract = new web3.eth.Contract(ABIConverterV28, address);
      return {
        converterAddress: "originAddress",
        connectorTokenCount: converterContract.methods.connectorTokenCount(),
      };
    });

    const multiCall = new MultiCall(
      web3,
      "0x5Eb3fa2DFECdDe21C950813C665E9364fa609bD2"
    );

    const [tokensRes, convertersRes] = await multiCall.all(
      [tokens, converters],
      { traditional: true }
    );

    expect(tokensRes).toStrictEqual([
      {
        symbol: "ANT",
        decimals: "18",
        tokenAddress: "0x960b236A07cf122663c4303350609A66A7B288C0",
        randomMeta: HELLOWORLD,
      },
      {
        symbol: "BNT",
        decimals: "18",
        tokenAddress: "0x1F573D6Fb3F13d689FF844B4cE37794d79a7FF1C",
        randomMeta: HELLOWORLD,
      },
    ]);
    expect(convertersRes).toStrictEqual([
      {
        connectorTokenCount: "2",
        converterAddress: "0xE870D00176b2C71AFD4c43ceA550228E22be4ABd",
      },
      {
        connectorTokenCount: "2",
        converterAddress: "0xca5d7661a4D9f1D3954E64664d8710fDc4FaA5b7",
      },
    ]);
  });

  // test("will throw properly", async () => {
  //   const addresses = ["0x722dd3F80BAC40c951b51BdD28Dd19d435762180"];

  //   const tokens = addresses.map((x) => {
  //     const token = new ropstenWeb3.eth.Contract(ABISmartToken, x);
  //     return {
  //       tokenAddress: "originAddress",
  //       symbol: token.methods.symbol(),
  //       decimals: token.methods.decimals(),
  //       randomMeta: HELLOWORLD,
  //     };
  //   });

  //   const multiCall = new MultiCall(
  //     ropstenWeb3,
  //     "0xf3ad7e31b052ff96566eedd218a823430e74b406",
  //     [3, 1]
  //   );

  //   expect.assertions(1);
  //   try {
  //     const [tokensRes] = await multiCall.all([tokens]);
  //     console.log(tokensRes, "came back");
  //   } catch (e) {
  //     expect(e.message).toBe("something");
  //   }
  // });

  test("can remove oversized chunks", () => {
    const res = removeOverSizedChunks(150, [600, 400, 300, 100, 50, 25]);
    expect(res).toStrictEqual([150, 100, 50, 25]);

    const chunks2 = [100, 80, 50];
    const res2 = removeOverSizedChunks(150, chunks2);
    expect(res2).toStrictEqual(chunks2);

    const chunks3 = [150, 100, 80, 50];
    const res3 = removeOverSizedChunks(150, chunks3);
    expect(res3).toStrictEqual(chunks3);
  });
});
