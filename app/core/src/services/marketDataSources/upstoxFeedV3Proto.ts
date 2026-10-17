// Vendored Upstox Market Data Feed V3 protobuf schema.
//
// Source: https://assets.upstox.com/feed/market-data-feed/v3/MarketDataFeed.proto
// Package: com.upstox.marketdatafeederv3udapi.rpc.proto (snapshot: Oct 2026)
//
// The schema is embedded as a string (instead of shipping a .proto asset) so the
// compiled daemon under dist/ is self-contained. The schema imports
// google/protobuf/wrappers.proto for one unused field (LTPC.iep); protobufjs does
// not bundle that file, so a minimal DoubleValue stub is parsed into the same
// root first. Field numbers and wire format are unaffected.

import protobuf from 'protobufjs'

export const MARKET_DATA_FEED_V3_PACKAGE = 'com.upstox.marketdatafeederv3udapi.rpc.proto'

const GOOGLE_WRAPPERS_STUB = `
syntax = "proto3";
package google.protobuf;

message DoubleValue {
  double value = 1;
}
`

export const MARKET_DATA_FEED_V3_PROTO = `
syntax = "proto3";
package com.upstox.marketdatafeederv3udapi.rpc.proto;
import "google/protobuf/wrappers.proto";

message LTPC {
  double ltp = 1;
  int64 ltt = 2;
  int64 ltq = 3;
  double cp = 4;
  google.protobuf.DoubleValue iep = 5;
}

message MarketLevel {
  repeated Quote bidAskQuote = 1;
}

message MarketOHLC {
  repeated OHLC ohlc = 1;
}

message Quote {
  int64 bidQ = 1;
  double bidP = 2;
  int64 askQ = 3;
  double askP = 4;
}

message OptionGreeks {
  double delta = 1;
  double theta = 2;
  double gamma = 3;
  double vega = 4;
  double rho = 5;
}

message OHLC {
  string interval = 1;
  double open = 2;
  double high = 3;
  double low = 4;
  double close = 5;
  int64 vol = 6;
  int64 ts = 7;
}

enum Type{
  initial_feed = 0;
  live_feed = 1;
  market_info = 2;
}

message MarketFullFeed{
  LTPC ltpc = 1;
  MarketLevel marketLevel = 2;
  OptionGreeks optionGreeks = 3;
  MarketOHLC marketOHLC = 4;
  double atp = 5;
  int64 vtt = 6;
  double oi = 7;
  double iv = 8;
  double tbq =9;
  double tsq = 10;
  double iep = 11;
  double rp = 12;
  int64 ieq = 13;
  int64 iiqTotal = 14;
  int64 iiqM = 15;
  bool casEligible = 16;
}

message IndexFullFeed{
  LTPC ltpc = 1;
  MarketOHLC marketOHLC = 2;
}


message FullFeed {
  oneof FullFeedUnion {
    MarketFullFeed marketFF = 1;
    IndexFullFeed indexFF = 2;
  }
}

message FirstLevelWithGreeks{
  LTPC ltpc = 1;
  Quote firstDepth = 2;
  OptionGreeks optionGreeks = 3;
  int64 vtt = 4;
  double oi = 5;
  double iv = 6;
}

message Feed {
  oneof FeedUnion {
    LTPC ltpc = 1;
    FullFeed fullFeed = 2;
    FirstLevelWithGreeks firstLevelWithGreeks = 3;
  }
  RequestMode requestMode = 4;
}

enum RequestMode {
  ltpc = 0;
  full_d5 = 1;
  option_greeks = 2;
  full_d30 = 3;
}

enum MarketStatus {
  PRE_OPEN_START = 0;
  PRE_OPEN_END = 1;
  NORMAL_OPEN = 2;
  NORMAL_CLOSE = 3;
  CLOSING_START = 4;
  CLOSING_END = 5;
}


message StatusInfo {
  string status = 1;
  int64 updatedTime = 2;
}

message MarketInfo {
  map<string, MarketStatus> segmentStatus = 1;
  map<string, StatusInfo> casMarketStatus = 2;
  map<string, StatusInfo> preOpenSessionStatus = 3;
}

message FeedResponse{
  Type type = 1;
  map<string, Feed> feeds = 2;
  int64 currentTs = 3;
  MarketInfo marketInfo = 4;
}
`

// --- decoded shapes (only the fields the source consumes) ---

export interface DecodedLtpc {
  ltp?: number
  ltt?: number
  ltq?: number
  cp?: number
}

export interface DecodedOhlc {
  interval?: string
  open?: number
  high?: number
  low?: number
  close?: number
  vol?: number
  ts?: number
}

export interface DecodedOhlcSeries {
  ohlc?: DecodedOhlc[]
}

export interface DecodedIndexFullFeed {
  ltpc?: DecodedLtpc
  marketOHLC?: DecodedOhlcSeries
}

export interface DecodedMarketFullFeed {
  ltpc?: DecodedLtpc
  marketOHLC?: DecodedOhlcSeries
  optionGreeks?: { delta?: number; theta?: number; gamma?: number; vega?: number; rho?: number }
  oi?: number
  iv?: number
}

export interface DecodedFeed {
  ltpc?: DecodedLtpc
  fullFeed?: {
    marketFF?: DecodedMarketFullFeed
    indexFF?: DecodedIndexFullFeed
  }
  firstLevelWithGreeks?: {
    ltpc?: DecodedLtpc
    oi?: number
    iv?: number
  }
}

export interface DecodedFeedResponse {
  type?: string
  feeds?: Record<string, DecodedFeed>
  currentTs?: number
}

let cachedFeedResponseType: protobuf.Type | null = null

function feedResponseType(): protobuf.Type {
  if (!cachedFeedResponseType) {
    const root = new protobuf.Root()
    protobuf.parse(GOOGLE_WRAPPERS_STUB, root)
    protobuf.parse(MARKET_DATA_FEED_V3_PROTO, root)
    root.resolveAll()
    cachedFeedResponseType = root.lookupType(`${MARKET_DATA_FEED_V3_PACKAGE}.FeedResponse`)
  }
  return cachedFeedResponseType
}

/** Decode one binary FeedResponse frame from the V3 market-data feed. */
export function decodeFeedResponse(data: Uint8Array): DecodedFeedResponse {
  const message = feedResponseType().decode(data)
  return feedResponseType().toObject(message, {
    longs: Number,
    enums: String,
    defaults: false,
  }) as DecodedFeedResponse
}

/** Exposed for tooling/tests that need to encode synthetic frames. */
export function getFeedResponseType(): protobuf.Type {
  return feedResponseType()
}
