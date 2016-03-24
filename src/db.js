(function (local) {
    'use strict';

    const IDBKeyRange = local.IDBKeyRange || local.webkitIDBKeyRange;
    const transactionModes = {
        readonly: 'readonly',
        readwrite: 'readwrite'
    };
    const hasOwn = Object.prototype.hasOwnProperty;
    const defaultMapper = x => x;

    const indexedDB = local.indexedDB || local.webkitIndexedDB ||
        local.mozIndexedDB || local.oIndexedDB || local.msIndexedDB ||
        local.shimIndexedDB || (function () {
            throw new Error('IndexedDB required');
        }());

    const dbCache = {};
    const serverEvents = ['abort', 'error', 'versionchange'];

    function mongoDBToKeyRangeArgs (opts) {
        const keys = Object.keys(opts).sort();
        if (keys.length === 1) {
            const key = keys[0];
            const val = opts[key];
            let name, inclusive;
            switch (key) {
            case 'eq': name = 'only'; break;
            case 'gt':
                name = 'lowerBound';
                inclusive = true;
                break;
            case 'lt':
                name = 'upperBound';
                inclusive = true;
                break;
            case 'gte': name = 'lowerBound'; break;
            case 'lte': name = 'upperBound'; break;
            default: throw new TypeError('`' + key + '` is not valid key');
            }
            return [name, [val, inclusive]];
        }
        const x = opts[keys[0]];
        const y = opts[keys[1]];
        const pattern = keys.join('-');

        switch (pattern) {
        case 'gt-lt': case 'gt-lte': case 'gte-lt': case 'gte-lte':
            return ['bound', [x, y, keys[0] === 'gt', keys[1] === 'lt']];
        default: throw new TypeError(
          '`' + pattern + '` are conflicted keys'
        );
        }
    }
    function mongoifyKey (key) {
        if (key && typeof key === 'object' && !(key instanceof IDBKeyRange)) {
            let [type, args] = mongoDBToKeyRangeArgs(key);
            return IDBKeyRange[type](...args);
        }
        return key;
    }

    const Server = function (db, name, noServerMethods, version) {
        let closed = false;

        this.getIndexedDB = () => db;
        this.isClosed = () => closed;

        this.add = function (table, ...args) {
            return new Promise(function (resolve, reject) {
                if (closed) {
                    reject('Database has been closed');
                    return;
                }

                const records = args.reduce(function (records, aip) {
                    return records.concat(aip);
                }, []);

                const transaction = db.transaction(table, transactionModes.readwrite);
                transaction.oncomplete = () => resolve(records, this);
                transaction.onerror = e => {
                    // prevent Firefox from throwing a ConstraintError and aborting (hard)
                    // https://bugzilla.mozilla.org/show_bug.cgi?id=872873
                    e.preventDefault();
                    reject(e);
                };
                transaction.onabort = e => reject(e);

                const store = transaction.objectStore(table);
                records.forEach(function (record) {
                    let req;
                    if (record.item && record.key) {
                        const key = record.key;
                        record = record.item;
                        req = store.add(record, key);
                    } else {
                        req = store.add(record);
                    }

                    req.onsuccess = function (e) {
                        const target = e.target;
                        let keyPath = target.source.keyPath;
                        if (keyPath === null) {
                            keyPath = '__id__';
                        }
                        Object.defineProperty(record, keyPath, {
                            value: target.result,
                            enumerable: true
                        });
                    };
                });
            });
        };

        this.update = function (table, ...args) {
            return new Promise(function (resolve, reject) {
                if (closed) {
                    reject('Database has been closed');
                    return;
                }

                const transaction = db.transaction(table, transactionModes.readwrite);
                transaction.oncomplete = () => resolve(records, this);
                transaction.onerror = e => reject(e);
                transaction.onabort = e => reject(e);

                const store = transaction.objectStore(table);
                const records = args.reduce(function (records, aip) {
                    return records.concat(aip);
                }, []);
                records.forEach(function (record) {
                    if (record.item && record.key) {
                        const key = record.key;
                        record = record.item;
                        store.put(record, key);
                    } else {
                        store.put(record);
                    }
                });
            });
        };

        this.remove = function (table, key) {
            return new Promise(function (resolve, reject) {
                if (closed) {
                    reject('Database has been closed');
                    return;
                }
                const transaction = db.transaction(table, transactionModes.readwrite);
                transaction.oncomplete = () => resolve(key);
                transaction.onerror = e => reject(e);
                transaction.onabort = e => reject(e);

                const store = transaction.objectStore(table);
                store.delete(key);
            });
        };

        this.clear = function (table) {
            return new Promise(function (resolve, reject) {
                if (closed) {
                    reject('Database has been closed');
                    return;
                }
                const transaction = db.transaction(table, transactionModes.readwrite);
                transaction.oncomplete = () => resolve();
                transaction.onerror = e => reject(e);
                transaction.onabort = e => reject(e);

                const store = transaction.objectStore(table);
                store.clear();
            });
        };

        this.close = function () {
            return new Promise(function (resolve, reject) {
                if (closed) {
                    reject('Database has been closed');
                }
                db.close();
                closed = true;
                delete dbCache[name][version];
                resolve();
            });
        };

        this.get = function (table, key) {
            return new Promise(function (resolve, reject) {
                if (closed) {
                    reject('Database has been closed');
                    return;
                }
                const transaction = db.transaction(table);
                transaction.onerror = e => reject(e);
                transaction.onabort = e => reject(e);

                const store = transaction.objectStore(table);

                try {
                    key = mongoifyKey(key);
                } catch (e) {
                    reject(e);
                }
                const req = store.get(key);
                req.onsuccess = e => resolve(e.target.result);
            });
        };

        this.query = function (table, index) {
            const error = closed ? 'Database has been closed' : null;
            return new IndexQuery(table, db, index, error);
        };

        this.count = function (table, key) {
            return new Promise((resolve, reject) => {
                if (closed) {
                    reject('Database has been closed');
                    return;
                }
                const transaction = db.transaction(table);
                transaction.onerror = e => reject(e);
                transaction.onabort = e => reject(e);

                const store = transaction.objectStore(table);
                try {
                    key = mongoifyKey(key);
                } catch (e) {
                    reject(e);
                }
                const req = key === undefined ? store.count() : store.count(key);
                req.onsuccess = e => resolve(e.target.result);
            });
        };

        this.addEventListener = function (eventName, handler) {
            if (!serverEvents.includes(eventName)) {
                throw new Error('Unrecognized event type ' + eventName);
            }
            db.addEventListener(eventName, handler);
        };

        this.removeEventListener = function (eventName, handler) {
            if (!serverEvents.includes(eventName)) {
                throw new Error('Unrecognized event type ' + eventName);
            }
            db.removeEventListener(eventName, handler);
        };

        serverEvents.forEach(function (evName) {
            this[evName] = function (handler) {
                this.addEventListener(evName, handler);
            };
        }, this);

        if (noServerMethods) {
            return;
        }

        let err;
        [].some.call(db.objectStoreNames, storeName => {
            if (this[storeName]) {
                err = new Error('The store name, "' + storeName + '", which you have attempted to load, conflicts with db.js method names."');
                this.close();
                return true;
            }
            this[storeName] = {};
            const keys = Object.keys(this);
            keys.filter(key => !(([...serverEvents, 'close', 'addEventListener', 'removeEventListener']).includes(key)))
                .map(key =>
                    this[storeName][key] = (...args) => this[key](storeName, ...args)
                );
        });
        return err;
    };

    const IndexQuery = function (table, db, indexName, preexistingError) {
        let modifyObj = false;

        const runQuery = function (type, args, cursorType, direction, limitRange, filters, mapper) {
            return new Promise(function (resolve, reject) {
                let keyRange;
                try {
                    keyRange = type ? IDBKeyRange[type](...args) : null;
                } catch (e) {
                    reject(e);
                }
                let results = [];
                const indexArgs = [keyRange];
                let counter = 0;

                const transaction = db.transaction(table, modifyObj ? transactionModes.readwrite : transactionModes.readonly);
                transaction.oncomplete = () => resolve(results);
                transaction.onerror = e => reject(e);
                transaction.onabort = e => reject(e);

                const store = transaction.objectStore(table);
                const index = indexName ? store.index(indexName) : store;

                limitRange = limitRange || null;
                filters = filters || [];
                if (cursorType !== 'count') {
                    indexArgs.push(direction || 'next');
                }

                // create a function that will set in the modifyObj properties into
                // the passed record.
                const modifyKeys = modifyObj ? Object.keys(modifyObj) : [];

                const modifyRecord = function (record) {
                    modifyKeys.forEach(key => {
                        let val = modifyObj[key];
                        if (typeof val === 'function') { val = val(record); }
                        record[key] = val;
                    });
                    return record;
                };

                index[cursorType](...indexArgs).onsuccess = function (e) {
                    const cursor = e.target.result;
                    if (typeof cursor === 'number') {
                        results = cursor;
                    } else if (cursor) {
                        if (limitRange !== null && limitRange[0] > counter) {
                            counter = limitRange[0];
                            cursor.advance(limitRange[0]);
                        } else if (limitRange !== null && counter >= (limitRange[0] + limitRange[1])) {
                            // out of limit range... skip
                        } else {
                            let matchFilter = true;
                            let result = 'value' in cursor ? cursor.value : cursor.key;

                            filters.forEach(function (filter) {
                                if (!filter || !filter.length) {
                                    // Invalid filter do nothing
                                } else if (filter.length === 2) {
                                    matchFilter = matchFilter && (result[filter[0]] === filter[1]);
                                } else {
                                    matchFilter = matchFilter && filter[0](result);
                                }
                            });

                            if (matchFilter) {
                                counter++;
                                // if we're doing a modify, run it now
                                if (modifyObj) {
                                    result = modifyRecord(result);
                                    cursor.update(result);
                                }
                                results.push(mapper(result));
                            }
                            cursor.continue();
                        }
                    }
                };
            });
        };

        const Query = function (type, args, queuedError) {
            let direction = 'next';
            let cursorType = 'openCursor';
            const filters = [];
            let limitRange = null;
            let mapper = defaultMapper;
            let unique = false;
            const error = preexistingError || queuedError;

            const execute = function () {
                if (error) {
                    return Promise.reject(error);
                }
                return runQuery(type, args, cursorType, unique ? direction + 'unique' : direction, limitRange, filters, mapper);
            };

            const limit = function (...args) {
                limitRange = args.slice(0, 2);
                if (limitRange.length === 1) {
                    limitRange.unshift(0);
                }

                return {
                    execute
                };
            };
            const count = function () {
                direction = null;
                cursorType = 'count';

                return {
                    execute
                };
            };

            const keys = function () {
                cursorType = 'openKeyCursor';

                return {
                    desc,
                    execute,
                    filter,
                    distinct,
                    map
                };
            };
            const filter = function (...args) {
                filters.push(args.slice(0, 2));

                return {
                    keys,
                    execute,
                    filter,
                    desc,
                    distinct,
                    modify,
                    limit,
                    map
                };
            };
            const desc = function () {
                direction = 'prev';

                return {
                    keys,
                    execute,
                    filter,
                    distinct,
                    modify,
                    map
                };
            };
            const distinct = function () {
                unique = true;
                return {
                    keys,
                    count,
                    execute,
                    filter,
                    desc,
                    modify,
                    map
                };
            };
            const modify = function (update) {
                modifyObj = update;
                return {
                    execute
                };
            };
            const map = function (fn) {
                mapper = fn;

                return {
                    execute,
                    count,
                    keys,
                    filter,
                    desc,
                    distinct,
                    modify,
                    limit,
                    map
                };
            };

            return {
                execute,
                count,
                keys,
                filter,
                desc,
                distinct,
                modify,
                limit,
                map
            };
        };

        ['only', 'bound', 'upperBound', 'lowerBound'].forEach((name) => {
            this[name] = function () {
                return Query(name, arguments);
            };
        });

        this.range = function (opts) {
            let error;
            let keyRange = [null, null];
            try {
                keyRange = mongoDBToKeyRangeArgs(opts);
            } catch (e) {
                error = e;
            }
            return Query(...keyRange, error);
        };

        this.filter = function (...args) {
            const query = Query(null, null);
            return query.filter(...args);
        };

        this.all = function () {
            return this.filter();
        };
    };

    const createSchema = function (e, schema, db) {
        if (!schema || schema.length === 0) {
            return;
        }

        for (let i = 0; i < db.objectStoreNames.length; i++) {
            const name = db.objectStoreNames[i];
            if (!schema.hasOwnProperty(name)) {
                e.currentTarget.transaction.db.deleteObjectStore(name);
            }
        }

        for (let tableName in schema) {
            const table = schema[tableName];
            let store;
            if (!hasOwn.call(schema, tableName) || db.objectStoreNames.contains(tableName)) {
                store = e.currentTarget.transaction.objectStore(tableName);
            } else {
                store = db.createObjectStore(tableName, table.key);
            }

            for (let indexKey in table.indexes) {
                const index = table.indexes[indexKey];
                try {
                    store.index(indexKey);
                } catch (err) {
                    store.createIndex(indexKey, index.key || indexKey, Object.keys(index).length ? index : { unique: false });
                }
            }
        }
    };

    const open = function (e, server, noServerMethods, version) {
        const db = e.target.result;
        dbCache[server][version] = db;

        const s = new Server(db, server, noServerMethods, version);
        return s instanceof Error ? Promise.reject(s) : Promise.resolve(s);
    };

    const db = {
        version: '0.14.0',
        open: function (options) {
            let server = options.server;
            let version = options.version || 1;
            let schema = options.schema;
            let noServerMethods = options.noServerMethods;

            if (!dbCache[server]) {
                dbCache[server] = {};
            }
            return new Promise(function (resolve, reject) {
                if (dbCache[server][version]) {
                    open({
                        target: {
                            result: dbCache[server][version]
                        }
                    }, server, noServerMethods, version)
                    .then(resolve, reject);
                } else {
                    if (typeof schema === 'function') {
                        try {
                            schema = schema();
                        } catch (e) {
                            reject(e);
                            return;
                        }
                    }
                    let request = indexedDB.open(server, version);

                    request.onsuccess = e => open(e, server, noServerMethods, version).then(resolve, reject);
                    request.onupgradeneeded = e => createSchema(e, schema, e.target.result);
                    request.onerror = e => reject(e);
                    request.onblocked = e => {
                        const resume = new Promise(function (res, rej) {
                            // We overwrite handlers rather than make a new
                            //   open() since the original request is still
                            //   open and its onsuccess will still fire if
                            //   the user unblocks by closing the blocking
                            //   connection
                            request.onsuccess = (ev) => {
                                open(ev, server, noServerMethods, version)
                                    .then(res, rej);
                            };
                            request.onerror = e => rej(e);
                        });
                        e.resume = resume;
                        reject(e);
                    };
                }
            });
        },

        delete: function (dbName) {
            return new Promise(function (resolve, reject) {
                const request = indexedDB.deleteDatabase(dbName); // Does not throw

                request.onsuccess = e => resolve(e);
                request.onerror = e => reject(e); // No errors currently
                request.onblocked = e => {
                    const resume = new Promise(function (res, rej) {
                        // We overwrite handlers rather than make a new
                        //   delete() since the original request is still
                        //   open and its onsuccess will still fire if
                        //   the user unblocks by closing the blocking
                        //   connection
                        request.onsuccess = ev => {
                            // Attempt to workaround Firefox event version problem: https://bugzilla.mozilla.org/show_bug.cgi?id=1220279
                            if (!('newVersion' in ev)) {
                                ev.newVersion = e.newVersion;
                            }

                            if (!('oldVersion' in ev)) {
                                ev.oldVersion = e.oldVersion;
                            }

                            res(ev);
                        };
                        request.onerror = e => rej(e);
                    });
                    e.resume = resume;
                    reject(e);
                };
            });
        },

        cmp: function (param1, param2) {
            return new Promise(function (resolve, reject) {
                try {
                    resolve(indexedDB.cmp(param1, param2));
                } catch (e) {
                    reject(e);
                }
            });
        }
    };

    if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
        module.exports = db;
    } else if (typeof define === 'function' && define.amd) {
        define(function () { return db; });
    } else {
        local.db = db;
    }
}(self));
