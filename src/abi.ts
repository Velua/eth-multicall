import { AbiItem } from "web3-utils";

export const ABIMultiCallContract: AbiItem[] = [
  {
    constant: false,
    inputs: [
      {
        components: [
          { internalType: "address", name: "target", type: "address" },
          { internalType: "bytes", name: "callData", type: "bytes" },
        ],
        internalType: "struct Multicall.Call[]",
        name: "calls",
        type: "tuple[]",
      },
      { internalType: "bool", name: "strict", type: "bool" },
    ],
    name: "aggregate",
    outputs: [
      { internalType: "uint256", name: "blockNumber", type: "uint256" },
      {
        components: [
          { internalType: "bool", name: "success", type: "bool" },
          { internalType: "bytes", name: "data", type: "bytes" },
        ],
        internalType: "struct Multicall.Return[]",
        name: "returnData",
        type: "tuple[]",
      },
    ],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
];
