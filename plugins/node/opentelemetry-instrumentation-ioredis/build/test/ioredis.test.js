"use strict";
/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const api_1 = require("@opentelemetry/api");
const sdk_trace_node_1 = require("@opentelemetry/sdk-trace-node");
const context_async_hooks_1 = require("@opentelemetry/context-async-hooks");
const testUtils = require("@opentelemetry/contrib-test-utils");
const sdk_trace_base_1 = require("@opentelemetry/sdk-trace-base");
const assert = require("assert");
const sinon = require("sinon");
const src_1 = require("../src");
const semantic_conventions_1 = require("@opentelemetry/semantic-conventions");
const memoryExporter = new sdk_trace_base_1.InMemorySpanExporter();
const CONFIG = {
    host: process.env.OPENTELEMETRY_REDIS_HOST || 'localhost',
    port: parseInt(process.env.OPENTELEMETRY_REDIS_PORT || '63790', 10),
};
const REDIS_URL = `redis://${CONFIG.host}:${CONFIG.port}`;
const DEFAULT_ATTRIBUTES = {
    [semantic_conventions_1.SEMATTRS_DB_SYSTEM]: semantic_conventions_1.DBSYSTEMVALUES_REDIS,
    [semantic_conventions_1.SEMATTRS_NET_PEER_NAME]: CONFIG.host,
    [semantic_conventions_1.SEMATTRS_NET_PEER_PORT]: CONFIG.port,
    [semantic_conventions_1.SEMATTRS_DB_CONNECTION_STRING]: REDIS_URL,
};
const unsetStatus = {
    code: api_1.SpanStatusCode.UNSET,
};
const predictableStackTrace = '-- Stack trace replaced by test to predictable value -- ';
const sanitizeEventForAssertion = (span) => {
    span.events.forEach(e => {
        // stack trace includes data such as /user/{userName}/repos/{projectName}
        if (e.attributes?.[semantic_conventions_1.SEMATTRS_EXCEPTION_STACKTRACE]) {
            e.attributes[semantic_conventions_1.SEMATTRS_EXCEPTION_STACKTRACE] = predictableStackTrace;
        }
        // since time will change on each test invocation, it is being replaced to predicable value
        e.time = [0, 0];
    });
};
describe('ioredis', () => {
    const provider = new sdk_trace_node_1.NodeTracerProvider({
        spanProcessors: [new sdk_trace_base_1.SimpleSpanProcessor(memoryExporter)],
    });
    let ioredis;
    let instrumentation;
    const shouldTestLocal = process.env.RUN_REDIS_TESTS_LOCAL;
    const shouldTest = process.env.RUN_REDIS_TESTS || shouldTestLocal;
    let contextManager;
    beforeEach(() => {
        contextManager = new context_async_hooks_1.AsyncLocalStorageContextManager().enable();
        api_1.context.setGlobalContextManager(contextManager);
    });
    afterEach(() => {
        api_1.context.disable();
    });
    before(function () {
        // needs to be "function" to have MochaContext "this" context
        if (!shouldTest) {
            // this.skip() workaround
            // https://github.com/mochajs/mocha/issues/2683#issuecomment-375629901
            this.test.parent.pending = true;
            this.skip();
        }
        if (shouldTestLocal) {
            testUtils.startDocker('redis');
        }
        instrumentation = new src_1.IORedisInstrumentation();
        instrumentation.setTracerProvider(provider);
        ioredis = require('ioredis');
    });
    after(() => {
        if (shouldTestLocal) {
            testUtils.cleanUpDocker('redis');
        }
    });
    it('should have correct module name', () => {
        assert.strictEqual(instrumentation.instrumentationName, '@opentelemetry/instrumentation-ioredis');
    });
    describe('#createClient()', () => {
        it('should propagate the current span to event handlers', done => {
            const span = provider.getTracer('ioredis-test').startSpan('test span');
            let client;
            const attributes = {
                ...DEFAULT_ATTRIBUTES,
                [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: 'connect',
            };
            const readyHandler = () => {
                const endedSpans = memoryExporter.getFinishedSpans();
                assert.strictEqual(api_1.trace.getSpan(api_1.context.active()), span);
                assert.strictEqual(endedSpans.length, 2);
                assert.strictEqual(endedSpans[0].name, 'connect');
                assert.strictEqual(endedSpans[1].name, 'info');
                testUtils.assertPropagation(endedSpans[0], span);
                testUtils.assertSpan(endedSpans[0], api_1.SpanKind.CLIENT, attributes, [], unsetStatus);
                span.end();
                assert.strictEqual(endedSpans.length, 3);
                assert.strictEqual(endedSpans[2].name, 'test span');
                client.quit(() => {
                    assert.strictEqual(endedSpans.length, 4);
                    assert.strictEqual(endedSpans[3].name, 'quit');
                    done();
                });
            };
            const errorHandler = (err) => {
                assert.ifError(err);
                client.quit(done);
            };
            api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), () => {
                client = new ioredis(REDIS_URL);
                client.on('ready', readyHandler);
                client.on('error', errorHandler);
            });
        });
    });
    describe('#send_internal_message()', () => {
        // use a random part in key names because redis instance is used for parallel running tests
        const randomId = ((Math.random() * 2 ** 32) >>> 0).toString(16);
        const testKeyName = `test-${randomId}`;
        const hashKeyName = `hash-${randomId}`;
        let client;
        const IOREDIS_CALLBACK_OPERATIONS = [
            {
                description: 'insert',
                name: 'hset',
                args: [hashKeyName, 'testField', 'testValue'],
                expectedDbStatement: `${hashKeyName} testField [1 other arguments]`,
                method: (cb) => client.hset(hashKeyName, 'testField', 'testValue', cb),
            },
            {
                description: 'get',
                name: 'get',
                args: [testKeyName],
                expectedDbStatement: `${testKeyName}`,
                method: (cb) => client.get(testKeyName, cb),
            },
        ];
        before(done => {
            client = new ioredis(REDIS_URL);
            client.on('error', err => {
                done(err);
            });
            client.on('ready', done);
        });
        beforeEach(async () => {
            await client.set(testKeyName, 'data');
            memoryExporter.reset();
        });
        after(done => {
            client.quit(done);
        });
        afterEach(async () => {
            await client.del(hashKeyName);
            await client.del(testKeyName);
            await client.del('response-hook-test');
            memoryExporter.reset();
        });
        describe('Instrumenting query operations', () => {
            before(() => {
                instrumentation.disable();
                instrumentation = new src_1.IORedisInstrumentation();
                instrumentation.setTracerProvider(provider);
                require('ioredis');
            });
            IOREDIS_CALLBACK_OPERATIONS.forEach(command => {
                it(`should create a child span for cb style ${command.description}`, done => {
                    const attributes = {
                        ...DEFAULT_ATTRIBUTES,
                        [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: `${command.name} ${command.expectedDbStatement}`,
                    };
                    const span = provider
                        .getTracer('ioredis-test')
                        .startSpan('test span');
                    api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), () => {
                        command.method((err, _result) => {
                            assert.ifError(err);
                            assert.strictEqual(memoryExporter.getFinishedSpans().length, 1);
                            span.end();
                            const endedSpans = memoryExporter.getFinishedSpans();
                            assert.strictEqual(endedSpans.length, 2);
                            assert.strictEqual(endedSpans[0].name, command.name);
                            testUtils.assertSpan(endedSpans[0], api_1.SpanKind.CLIENT, attributes, [], unsetStatus);
                            testUtils.assertPropagation(endedSpans[0], span);
                            done();
                        });
                    });
                });
            });
            it('should create a child span for hset promise', async () => {
                const attributes = {
                    ...DEFAULT_ATTRIBUTES,
                    [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: `hset ${hashKeyName} random [1 other arguments]`,
                };
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                await api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), async () => {
                    try {
                        await client.hset(hashKeyName, 'random', 'random');
                        assert.strictEqual(memoryExporter.getFinishedSpans().length, 1);
                        span.end();
                        const endedSpans = memoryExporter.getFinishedSpans();
                        assert.strictEqual(endedSpans.length, 2);
                        assert.strictEqual(endedSpans[0].name, 'hset');
                        testUtils.assertSpan(endedSpans[0], api_1.SpanKind.CLIENT, attributes, [], unsetStatus);
                        testUtils.assertPropagation(endedSpans[0], span);
                    }
                    catch (error) {
                        assert.ifError(error);
                    }
                });
            });
            it('should set span with error when redis return reject', async () => {
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                await api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), async () => {
                    await client.set('non-int-key', 'non-int-value');
                    try {
                        // should throw 'ReplyError: ERR value is not an integer or out of range'
                        // because the value im the key is not numeric and we try to increment it
                        await client.incr('non-int-key');
                    }
                    catch (ex) {
                        const endedSpans = memoryExporter.getFinishedSpans();
                        assert.strictEqual(endedSpans.length, 2);
                        const ioredisSpan = endedSpans[1];
                        // redis 'incr' operation failed with exception, so span should indicate it
                        assert.strictEqual(ioredisSpan.status.code, api_1.SpanStatusCode.ERROR);
                        const exceptionEvent = ioredisSpan.events[0];
                        assert.strictEqual(exceptionEvent.name, 'exception');
                        assert.strictEqual(exceptionEvent.attributes?.[semantic_conventions_1.SEMATTRS_EXCEPTION_MESSAGE], ex.message);
                        assert.strictEqual(exceptionEvent.attributes?.[semantic_conventions_1.SEMATTRS_EXCEPTION_STACKTRACE], ex.stack);
                        assert.strictEqual(exceptionEvent.attributes?.[semantic_conventions_1.SEMATTRS_EXCEPTION_TYPE], ex.name);
                    }
                });
            });
            it('should create a child span for streamify scanning', done => {
                const attributes = {
                    ...DEFAULT_ATTRIBUTES,
                    [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: 'scan 0 MATCH test-* COUNT 1000',
                };
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), () => {
                    const stream = client.scanStream({
                        count: 1000,
                        match: 'test-*',
                    });
                    stream
                        .on('end', () => {
                        assert.strictEqual(memoryExporter.getFinishedSpans().length, 1);
                        span.end();
                        const endedSpans = memoryExporter.getFinishedSpans();
                        assert.strictEqual(endedSpans.length, 2);
                        assert.strictEqual(endedSpans[0].name, 'scan');
                        testUtils.assertSpan(endedSpans[0], api_1.SpanKind.CLIENT, attributes, [], unsetStatus);
                        testUtils.assertPropagation(endedSpans[0], span);
                        done();
                    })
                        .on('error', err => {
                        done(err);
                    });
                    // Put stream into flowing mode so it will invoke 'end' listener
                    stream.resume();
                });
            });
            it.skip('should create a child span for pubsub', async () => {
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                await api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), async () => {
                    try {
                        // use lazyConnect so we can call the `connect` function and await it.
                        // this ensures that all operations are sequential and predictable.
                        const pub = new ioredis(REDIS_URL, { lazyConnect: true });
                        await pub.connect();
                        const sub = new ioredis(REDIS_URL, { lazyConnect: true });
                        await sub.connect();
                        await sub.subscribe('news', 'music');
                        await pub.publish('news', 'Hello world!');
                        await pub.publish('music', 'Hello again!');
                        await sub.unsubscribe('news', 'music');
                        await sub.quit();
                        await pub.quit();
                        const endedSpans = memoryExporter.getFinishedSpans();
                        assert.strictEqual(endedSpans.length, 10);
                        span.end();
                        assert.strictEqual(endedSpans.length, 11);
                        const expectedSpanNames = [
                            'connect',
                            'info',
                            'connect',
                            'info',
                            'subscribe',
                            'publish',
                            'publish',
                            'unsubscribe',
                            'quit',
                            'quit',
                            'test span',
                        ];
                        const actualSpanNames = endedSpans.map(s => s.name);
                        assert.deepStrictEqual(actualSpanNames.sort(), expectedSpanNames.sort());
                        const attributes = {
                            ...DEFAULT_ATTRIBUTES,
                            [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: 'subscribe news music',
                        };
                        testUtils.assertSpan(endedSpans[4], api_1.SpanKind.CLIENT, attributes, [], unsetStatus);
                        testUtils.assertPropagation(endedSpans[0], span);
                    }
                    catch (error) {
                        assert.ifError(error);
                    }
                });
            });
            it('should create a child span for multi/transaction', done => {
                const attributes = {
                    ...DEFAULT_ATTRIBUTES,
                    [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: 'multi',
                };
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), () => {
                    client
                        .multi()
                        .set('foo', 'bar')
                        .get('foo')
                        .exec((err, _results) => {
                        assert.ifError(err);
                        assert.strictEqual(memoryExporter.getFinishedSpans().length, 4);
                        span.end();
                        const endedSpans = memoryExporter.getFinishedSpans();
                        assert.strictEqual(endedSpans.length, 5);
                        assert.strictEqual(endedSpans[0].name, 'multi');
                        assert.strictEqual(endedSpans[1].name, 'set');
                        assert.strictEqual(endedSpans[2].name, 'get');
                        assert.strictEqual(endedSpans[3].name, 'exec');
                        testUtils.assertSpan(endedSpans[0], api_1.SpanKind.CLIENT, attributes, [], unsetStatus);
                        testUtils.assertPropagation(endedSpans[0], span);
                        done();
                    });
                });
            });
            it('should create a child span for pipeline', done => {
                const attributes = {
                    ...DEFAULT_ATTRIBUTES,
                    [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: 'set foo [1 other arguments]',
                };
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), () => {
                    const pipeline = client.pipeline();
                    pipeline.set('foo', 'bar');
                    pipeline.del('cc');
                    pipeline.exec((err, results) => {
                        assert.ifError(err);
                        assert.strictEqual(memoryExporter.getFinishedSpans().length, 2);
                        span.end();
                        const endedSpans = memoryExporter.getFinishedSpans();
                        assert.strictEqual(endedSpans.length, 3);
                        assert.strictEqual(endedSpans[0].name, 'set');
                        assert.strictEqual(endedSpans[1].name, 'del');
                        assert.strictEqual(endedSpans[2].name, 'test span');
                        testUtils.assertSpan(endedSpans[0], api_1.SpanKind.CLIENT, attributes, [], unsetStatus);
                        testUtils.assertPropagation(endedSpans[0], span);
                        done();
                    });
                });
            });
            it('should create a child span for get promise', async () => {
                const attributes = {
                    ...DEFAULT_ATTRIBUTES,
                    [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: `get ${testKeyName}`,
                };
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                await api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), async () => {
                    try {
                        const value = await client.get(testKeyName);
                        assert.strictEqual(value, 'data');
                        assert.strictEqual(memoryExporter.getFinishedSpans().length, 1);
                        span.end();
                        const endedSpans = memoryExporter.getFinishedSpans();
                        assert.strictEqual(endedSpans.length, 2);
                        assert.strictEqual(endedSpans[0].name, 'get');
                        testUtils.assertSpan(endedSpans[0], api_1.SpanKind.CLIENT, attributes, [], unsetStatus);
                        testUtils.assertPropagation(endedSpans[0], span);
                    }
                    catch (error) {
                        assert.ifError(error);
                    }
                });
            });
            it('should create a child span for del', async () => {
                const attributes = {
                    ...DEFAULT_ATTRIBUTES,
                    [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: `del ${testKeyName}`,
                };
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                await api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), async () => {
                    try {
                        const result = await client.del(testKeyName);
                        assert.strictEqual(result, 1);
                        assert.strictEqual(memoryExporter.getFinishedSpans().length, 1);
                        span.end();
                        const endedSpans = memoryExporter.getFinishedSpans();
                        assert.strictEqual(endedSpans.length, 2);
                        assert.strictEqual(endedSpans[0].name, 'del');
                        testUtils.assertSpan(endedSpans[0], api_1.SpanKind.CLIENT, attributes, [], unsetStatus);
                        testUtils.assertPropagation(endedSpans[0], span);
                    }
                    catch (error) {
                        assert.ifError(error);
                    }
                });
            });
            it('should create a child span for lua', done => {
                const config = {
                    requireParentSpan: false,
                };
                instrumentation.setConfig(config);
                const attributes = {
                    ...DEFAULT_ATTRIBUTES,
                    [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: `evalsha bfbf458525d6a0b19200bfd6db3af481156b367b 1 ${testKeyName}`,
                };
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), () => {
                    // This will define a command echo:
                    client.defineCommand('echo', {
                        numberOfKeys: 1,
                        lua: 'return {KEYS[1],ARGV[1]}',
                    });
                    // Now `echo` can be used just like any other ordinary command,
                    // and ioredis will try to use `EVALSHA` internally when possible for better performance.
                    client.echo(testKeyName, (err, result) => {
                        assert.ifError(err);
                        span.end();
                        const endedSpans = memoryExporter.getFinishedSpans();
                        const evalshaSpan = endedSpans[0];
                        // the script may be already cached on server therefore we get either 2 or 3 spans
                        if (endedSpans.length === 3) {
                            assert.strictEqual(endedSpans[2].name, 'test span');
                            assert.strictEqual(endedSpans[1].name, 'eval');
                            assert.strictEqual(endedSpans[0].name, 'evalsha');
                            // in this case, server returns NOSCRIPT error for evalsha,
                            // telling the client to use EVAL instead
                            sanitizeEventForAssertion(evalshaSpan);
                            testUtils.assertSpan(evalshaSpan, api_1.SpanKind.CLIENT, attributes, [
                                {
                                    attributes: {
                                        [semantic_conventions_1.SEMATTRS_EXCEPTION_MESSAGE]: 'NOSCRIPT No matching script. Please use EVAL.',
                                        [semantic_conventions_1.SEMATTRS_EXCEPTION_STACKTRACE]: predictableStackTrace,
                                        [semantic_conventions_1.SEMATTRS_EXCEPTION_TYPE]: 'ReplyError',
                                    },
                                    name: 'exception',
                                    time: [0, 0],
                                    droppedAttributesCount: 0,
                                },
                            ], {
                                code: api_1.SpanStatusCode.ERROR,
                            });
                        }
                        else {
                            assert.strictEqual(endedSpans.length, 2);
                            assert.strictEqual(endedSpans[1].name, 'test span');
                            assert.strictEqual(endedSpans[0].name, 'evalsha');
                            testUtils.assertSpan(evalshaSpan, api_1.SpanKind.CLIENT, attributes, [], unsetStatus);
                        }
                        testUtils.assertPropagation(evalshaSpan, span);
                        done();
                    });
                });
            });
        });
        describe('Instrumenting without parent span', () => {
            before(() => {
                const config = {
                    requireParentSpan: true,
                };
                instrumentation.setConfig(config);
            });
            it('should not create child span for query', async () => {
                await client.set(testKeyName, 'data');
                const result = await client.del(testKeyName);
                assert.strictEqual(result, 1);
                assert.strictEqual(memoryExporter.getFinishedSpans().length, 0);
            });
            it('should not create child span for connect', async () => {
                const lazyClient = new ioredis(REDIS_URL, { lazyConnect: true });
                await lazyClient.connect();
                const spans = memoryExporter.getFinishedSpans();
                await lazyClient.quit();
                assert.strictEqual(spans.length, 0);
            });
        });
        describe('Instrumentation with requireParentSpan', () => {
            it('should instrument queries with requireParentSpan equal false', async () => {
                const config = {
                    requireParentSpan: false,
                };
                instrumentation.setConfig(config);
                await client.set(testKeyName, 'data');
                const result = await client.del(testKeyName);
                assert.strictEqual(result, 1);
                const endedSpans = memoryExporter.getFinishedSpans();
                assert.strictEqual(endedSpans.length, 2);
                testUtils.assertSpan(endedSpans[0], api_1.SpanKind.CLIENT, {
                    ...DEFAULT_ATTRIBUTES,
                    [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: `set ${testKeyName} [1 other arguments]`,
                }, [], unsetStatus);
            });
            it.skip('should instrument connect with requireParentSpan equal false', async () => {
                const config = {
                    requireParentSpan: false,
                };
                instrumentation.setConfig(config);
                const lazyClient = new ioredis(REDIS_URL, { lazyConnect: true });
                await lazyClient.connect();
                const endedSpans = memoryExporter.getFinishedSpans();
                assert.strictEqual(endedSpans.length, 2);
                assert.strictEqual(endedSpans[0].name, 'connect');
                assert.strictEqual(endedSpans[1].name, 'info');
                await lazyClient.quit();
                testUtils.assertSpan(endedSpans[0], api_1.SpanKind.CLIENT, {
                    ...DEFAULT_ATTRIBUTES,
                    [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: 'connect',
                }, [], unsetStatus);
            });
            it('should not instrument queries with requireParentSpan equal true', async () => {
                const config = {
                    requireParentSpan: true,
                };
                instrumentation.setConfig(config);
                await client.set(testKeyName, 'data');
                const result = await client.del(testKeyName);
                assert.strictEqual(result, 1);
                assert.strictEqual(memoryExporter.getFinishedSpans().length, 0);
            });
            it('should not instrument connect with requireParentSpan equal true', async () => {
                const config = {
                    requireParentSpan: true,
                };
                instrumentation.setConfig(config);
                const lazyClient = new ioredis(REDIS_URL, { lazyConnect: true });
                await lazyClient.connect();
                const endedSpans = memoryExporter.getFinishedSpans();
                assert.strictEqual(endedSpans.length, 0);
                await lazyClient.quit();
            });
        });
        describe('Instrumenting with a custom db.statement serializer', () => {
            const dbStatementSerializer = (cmdName, cmdArgs) => `FOOBAR_${cmdName}: ${cmdArgs[0]}`;
            before(() => {
                const config = {
                    dbStatementSerializer,
                };
                instrumentation.setConfig(config);
            });
            IOREDIS_CALLBACK_OPERATIONS.forEach(command => {
                it(`should tag the span with a custom db.statement for cb style ${command.description}`, done => {
                    const attributes = {
                        ...DEFAULT_ATTRIBUTES,
                        [semantic_conventions_1.SEMATTRS_DB_STATEMENT]: dbStatementSerializer(command.name, command.args),
                    };
                    const span = provider
                        .getTracer('ioredis-test')
                        .startSpan('test span');
                    api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), () => {
                        command.method((err, _result) => {
                            assert.ifError(err);
                            assert.strictEqual(memoryExporter.getFinishedSpans().length, 1);
                            span.end();
                            const endedSpans = memoryExporter.getFinishedSpans();
                            assert.strictEqual(endedSpans.length, 2);
                            assert.strictEqual(endedSpans[0].name, command.name);
                            testUtils.assertSpan(endedSpans[0], api_1.SpanKind.CLIENT, attributes, [], unsetStatus);
                            testUtils.assertPropagation(endedSpans[0], span);
                            done();
                        });
                    });
                });
            });
        });
        describe('Removing instrumentation', () => {
            before(() => {
                instrumentation.disable();
            });
            IOREDIS_CALLBACK_OPERATIONS.forEach(operation => {
                it(`should not create a child span for cb style ${operation.description}`, done => {
                    const span = provider
                        .getTracer('ioredis-test')
                        .startSpan('test span');
                    api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), () => {
                        operation.method((err, _) => {
                            assert.ifError(err);
                            assert.strictEqual(memoryExporter.getFinishedSpans().length, 0);
                            span.end();
                            const endedSpans = memoryExporter.getFinishedSpans();
                            assert.strictEqual(endedSpans.length, 1);
                            assert.strictEqual(endedSpans[0], span);
                            done();
                        });
                    });
                });
            });
            it('should not create a child span for hset promise upon error', async () => {
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                await api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), async () => {
                    try {
                        await client.hset(hashKeyName, 'random', 'random');
                        assert.strictEqual(memoryExporter.getFinishedSpans().length, 0);
                        span.end();
                        const endedSpans = memoryExporter.getFinishedSpans();
                        assert.strictEqual(endedSpans.length, 1);
                        assert.strictEqual(endedSpans[0].name, 'test span');
                    }
                    catch (error) {
                        assert.ifError(error);
                    }
                });
            });
        });
        describe('Instrumenting with a custom hooks', () => {
            before(() => {
                instrumentation.disable();
                instrumentation = new src_1.IORedisInstrumentation();
                instrumentation.setTracerProvider(provider);
                require('ioredis');
            });
            it('should call requestHook when set in config', async () => {
                const requestHook = sinon.spy((span, requestInfo) => {
                    span.setAttribute('attribute key from request hook', 'custom value from request hook');
                });
                instrumentation.setConfig({
                    requestHook,
                });
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                await api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), async () => {
                    await client.incr('request-hook-test');
                    const endedSpans = memoryExporter.getFinishedSpans();
                    assert.strictEqual(endedSpans.length, 1);
                    assert.strictEqual(endedSpans[0].attributes['attribute key from request hook'], 'custom value from request hook');
                });
                sinon.assert.calledOnce(requestHook);
                const [, requestInfo] = requestHook.firstCall.args;
                assert.ok(/\d{1,4}\.\d{1,4}\.\d{1,5}.*/.test(requestInfo.moduleVersion));
                assert.strictEqual(requestInfo.cmdName, 'incr');
                assert.deepStrictEqual(requestInfo.cmdArgs, ['request-hook-test']);
            });
            it('should ignore requestHook which throws exception', async () => {
                const requestHook = sinon.spy((span, _requestInfo) => {
                    span.setAttribute('attribute key BEFORE exception', 'this attribute is added to span BEFORE exception is thrown thus we can expect it');
                    throw Error('error thrown in requestHook');
                });
                instrumentation.setConfig({
                    requestHook,
                });
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                await api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), async () => {
                    await client.incr('request-hook-throw-test');
                    const endedSpans = memoryExporter.getFinishedSpans();
                    assert.strictEqual(endedSpans.length, 1);
                    assert.strictEqual(endedSpans[0].attributes['attribute key BEFORE exception'], 'this attribute is added to span BEFORE exception is thrown thus we can expect it');
                });
                sinon.assert.threw(requestHook);
            });
            it('should call responseHook when set in config', async () => {
                const responseHook = sinon.spy((span, cmdName, _cmdArgs, response) => {
                    span.setAttribute('attribute key from hook', 'custom value from hook');
                });
                instrumentation.setConfig({
                    responseHook,
                });
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                await api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), async () => {
                    await client.set('response-hook-test', 'test-value');
                    const endedSpans = memoryExporter.getFinishedSpans();
                    assert.strictEqual(endedSpans.length, 1);
                    assert.strictEqual(endedSpans[0].attributes['attribute key from hook'], 'custom value from hook');
                });
                sinon.assert.calledOnce(responseHook);
                const [, cmdName, , response] = responseHook.firstCall.args;
                assert.strictEqual(cmdName, 'set');
                assert.strictEqual(response.toString(), 'OK');
            });
            it('should ignore responseHook which throws exception', async () => {
                const responseHook = sinon.spy((_span, _cmdName, _cmdArgs, _response) => {
                    throw Error('error thrown in responseHook');
                });
                instrumentation.setConfig({
                    responseHook,
                });
                const span = provider.getTracer('ioredis-test').startSpan('test span');
                await api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), async () => {
                    await client.incr('response-hook-throw-test');
                    const endedSpans = memoryExporter.getFinishedSpans();
                    // hook throw exception, but span should not be affected
                    assert.strictEqual(endedSpans.length, 1);
                });
                sinon.assert.threw(responseHook);
            });
        });
        describe('setConfig - custom dbStatementSerializer config', () => {
            const dbStatementSerializer = (cmdName, cmdArgs) => {
                return Array.isArray(cmdArgs) && cmdArgs.length
                    ? `FooBar_${cmdName} ${cmdArgs.join(',')}`
                    : cmdName;
            };
            const config = {
                dbStatementSerializer: dbStatementSerializer,
            };
            before(() => {
                instrumentation.setConfig(config);
            });
            IOREDIS_CALLBACK_OPERATIONS.forEach(operation => {
                it(`should properly execute the db statement serializer for operation ${operation.description}`, done => {
                    const span = provider
                        .getTracer('ioredis-test')
                        .startSpan('test span');
                    api_1.context.with(api_1.trace.setSpan(api_1.context.active(), span), () => {
                        operation.method((err, _) => {
                            assert.ifError(err);
                            span.end();
                            const endedSpans = memoryExporter.getFinishedSpans();
                            assert.strictEqual(endedSpans.length, 2);
                            const expectedStatement = dbStatementSerializer(operation.name, operation.args);
                            assert.strictEqual(endedSpans[0].attributes[semantic_conventions_1.SEMATTRS_DB_STATEMENT], expectedStatement);
                            done();
                        });
                    });
                });
            });
        });
    });
    it('should work with ESM usage', async () => {
        await testUtils.runTestFixture({
            cwd: __dirname,
            argv: ['fixtures/use-ioredis.mjs', REDIS_URL],
            env: {
                NODE_OPTIONS: '--experimental-loader=@opentelemetry/instrumentation/hook.mjs',
                NODE_NO_WARNINGS: '1',
            },
            checkResult: (err, stdout, stderr) => {
                assert.ifError(err);
            },
            checkCollector: (collector) => {
                const spans = collector.sortedSpans;
                assert.strictEqual(spans[0].name, 'manual');
                assert.strictEqual(spans[1].name, 'set');
                assert.strictEqual(spans[1].parentSpanId, spans[0].spanId);
                assert.strictEqual(spans[2].name, 'get');
                assert.strictEqual(spans[2].parentSpanId, spans[0].spanId);
            },
        });
    });
});
//# sourceMappingURL=ioredis.test.js.map