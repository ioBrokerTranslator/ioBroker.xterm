'use strict';

const utils    = require('@iobroker/adapter-core');
const ws       = require('ws');
const { exec } = require('child_process');
const fs       = require('fs');
const path     = require('path');
const express  = require('express');
const LE       = require(utils.controllerDir + '/lib/letsencrypt.js');

const locationXterm = require.resolve('xterm').replace(/\\/g, '/');
const locationXtermFit = require.resolve('xterm-addon-fit').replace(/\\/g, '/');

const files = {
    'xterm.js': {path: locationXterm, contentType: 'text/javascript'},
    'xterm.js.map': {path: locationXterm + '.map', contentType: 'text/javascript'},
    'xterm.css': {path: locationXterm.replace('/lib/xterm.js', '/css/xterm.css'), contentType: 'text/css'},
    'xterm-addon-fit.js': {path: locationXtermFit, contentType: 'text/javascript'},
    'xterm-addon-fit.js.map': {path: locationXtermFit + '.map', contentType: 'text/javascript'},
    'index.html': {path: __dirname + '/public/index.html', contentType: 'text/html'},
    'favicon.ico': {path: __dirname + '/public/favicon.ico', contentType: 'image/x-icon'},
};

/**
 * The adapter instance
 * @type {ioBroker.Adapter}
 */
let adapter;
let server;
let connectedCounter = 0;

/**
 * Starts the adapter instance
 * @param {Partial<utils.AdapterOptions>} [options]
 */
function startAdapter(options) {
    // Create the adapter and define its methods
    return adapter = utils.adapter(Object.assign({}, options, {
        name: 'xterm',

        // The ready callback is called when databases are connected and adapter received configuration.
        // start here!
        ready: () => {
            if (adapter.config.secure) {
                // Load certificates
                adapter.getCertificates((err, certificates, leConfig) => {
                    adapter.config.certificates = certificates;
                    adapter.config.leConfig     = leConfig;
                    main()
                        .then(() => {});
                });
            } else {
                main()
                    .then(() => {});
            }
        }, // Main method defined below for readability

        // is called when adapter shuts down - callback has to be called under any circumstances!
        unload: callback => {
            try {
                // First sweep, soft close
                server.io && server.io.clients.forEach(socket => socket.close());

                setTimeout(() => {
                    // Second sweep, hard close
                    // for everyone who's left
                    server.io && server.io.clients.forEach(socket => {
                        if ([socket.OPEN, socket.CLOSING].includes(socket.readyState)) {
                            socket.terminate();
                        }
                    });

                    try {
                        server.server && server.server.close();
                    } catch (e) {
                        // ignore
                    }

                    callback();
                }, 300);
            } catch (e) {
                callback();
            }
        },
    }));
}

// Command execution
function executeCommand(command, ws, cb) {
    /*try {
        return execSync(`${command} 2>&1`, {encoding: 'utf8'});
    } catch (e) {
        return e;
    }*/
    const ls = exec(command);
    ls.stdout.on('data', data => {
        ws.send(JSON.stringify({data, error: true}));
    });

    ls.stderr.on('data', data => {
        console.log('stderr: ' + data.toString());
        ws.send(JSON.stringify({data, error: true}));
    });

    ls.on('exit', code => {
        ws._stdin = null;
        ws._process = null;
        console.log('child process exited with code ' + (code === null ? 'null' : code.toString()));
        cb && cb(code);
    });

    ls.stdin.setEncoding('utf8');

    ws._stdin = ls.stdin;
    ws._process = ls;
}

function isDirectory(thePath) {
    return fs.existsSync(thePath) && fs.statSync(thePath).isDirectory();
}

function cd(thePath) {
    thePath = thePath.trim();
    if (!thePath) {
        thePath = HOME_DIRECTORY;
    }
    if (thePath) {
        if (isDirectory(thePath)) {
            try {
                process.chdir(thePath);
            } catch (e) {
                return {
                    data: `cd ${thePath}: Unable to change directory`
                };
            }
        } else {
            return {
                data: `cd ${thePath}: No such directory`
            };
        }
    }
    return true;
}

function completion(pattern) {
    let scanPath = '';
    let completionPrefix = '';
    let completion = [];

    if (pattern) {
        if (!isDirectory(pattern)) {
            pattern = path.dirname(pattern);
            pattern = pattern === '.' ? '' : pattern;
        }
        if (pattern) {
            if (isDirectory(pattern)) {
                scanPath = completionPrefix = pattern;
                if (completionPrefix.substr(-1) !== '/') {
                    completionPrefix += '/';
                }
            }
        } else {
            scanPath = process.cwd();
        }
    } else {
        scanPath = process.cwd();
    }

    if (scanPath) {
        // Loading directory listing
        completion = fs.readdirSync(scanPath);
        completion.sort(String.naturalCompare);

        // Prefix
        if (completionPrefix && completion.length > 0) {
            completion = completion.map(c => completionPrefix + c);
        }
        // Pattern
        if (pattern && completion.length > 0) {
            completion = completion.filter(c => pattern === c.substr(0, pattern.length));
        }
    }

    return completion;
}

let HOME_DIRECTORY = '';
let cache = null;
function auth(req, callback) {
    const str = req.headers.Authorization || req.headers.authorization;
    if (cache && Date.now() - cache.ts < 10000 && cache.data === str) {
        return callback(true);
    }
    if (!str || !str.startsWith('Basic ')) {
        cache = null;
        return callback(false);
    }
    const data = Buffer.from(str.substring(6), 'base64').toString();
    const [name, password] = data.split(':');
    if (name !== 'admin' || !password) {
        cache = null;
        return callback(false);
    }

    adapter.checkPassword('admin', password, result => {
        if (result) {
            cache = {data: str, ts: Date.now()};
        } else {
            // TODO: ADD brute force protection
            cache = null;
        }

        callback(result);
    });
}

//settings: {
//    "port":   8080,
//    "auth":   false,
//    "secure": false,
//    "bind":   "0.0.0.0", // "::"
//}
function initWebServer(settings) {
    const server = {
        app:       null,
        server:    null,
        io:        null,
        settings:  settings
    };

    settings.port = parseInt(settings.port, 10) || 8099;

    if (settings.port) {
        if (settings.secure && !settings.certificates) {
            return null;
        }

        adapter.getPort(settings.port, async port => {
            if (parseInt(port, 10) !== settings.port && !adapter.config.findNextPort) {
                adapter.log.error('port ' + settings.port + ' already in use');
                return adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
            }

            settings.port = port;

            server.app = express();

            if (adapter.config.auth) {
                server.app.use((req, res, next) => {
                    auth(req, result => {
                        if (result) {
                            next();
                        } else {
                            res.set('WWW-Authenticate', 'Basic realm="xterm"');
                            res.status(401).send('Unauthorized');
                        }
                    });
                });
            }

            server.app.use((req, res) => {
                let file = req.url.split('?')[0];
                file = file.split('/').pop();

                if (files[file]) {
                    res.setHeader('Content-Type', files[file].contentType);
                    res.send(fs.readFileSync(files[file].path));
                } else if (!file || file === '/') {
                    res.setHeader('Content-Type', files['index.html'].contentType);
                    res.send(fs.readFileSync(files['index.html'].path));
                } else {
                    res.status(404).json({error: 'not found'});
                }
            });

            try {
                server.server = await LE.createServerAsync(server.app, settings, adapter.config.certificates, adapter.config.leConfig, adapter.log, adapter);
            } catch (err) {
                adapter.log.error(`Cannot create webserver: ${err}`);
                adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                return;
            }
            if (!server.server) {
                adapter.log.error(`Cannot create webserver`);
                adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                return;
            }

            let serverListening = false;
            server.server.on('error', e => {
                if (e.toString().includes('EACCES') && port <= 1024) {
                    adapter.log.error(`node.js process has no rights to start server on the port ${port}.\n` +
                        `Do you know that on linux you need special permissions for ports under 1024?\n` +
                        `You can call in shell following scrip to allow it for node.js: "iobroker fix"`
                    );
                } else {
                    adapter.log.error(`Cannot start server on ${settings.bind || '0.0.0.0'}:${port}: ${e}`);
                }
                if (!serverListening) {
                    adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
                }
            });

            // Start the web server
            server.server.listen(settings.port, (!settings.bind || settings.bind === '0.0.0.0') ? undefined : settings.bind || undefined, () => {
                serverListening = true;
                adapter.log.debug('XTerm is listening on '  + (adapter.config.port || 8099));
            });

            // upgrade socket
            server.server.on('upgrade', (request, socket, head) => {
                if (adapter.config.auth) {
                    auth(request, result => {
                        socket.___auth = result;
                        if (result) {
                            server.io.handleUpgrade(request, socket, head, socket =>
                                server.io.emit('connection', socket, request));
                        } else {
                            adapter.log.error('Cannot establish socket connection as no credentials found!');
                            socket.destroy();
                        }
                    });
                } else {
                    server.io.handleUpgrade(request, socket, head, socket =>
                        server.io.emit('connection', socket, request));
                }
            });

            settings.crossDomain     = true;
            settings.ttl             = settings.ttl || 3600;
            settings.forceWebSockets = settings.forceWebSockets || false;

            server.io = new ws.Server ({ noServer: true });

            server.io.on('connection', ws => {
                if (adapter.config.auth && !ws._socket.___auth) {
                    ws.close();
                    adapter.log.error('Cannot establish socket connection as no credentials found!');
                    return;
                }
                connectedCounter++;
                adapter.setState('info.connection', true, true);

                ws.on('message', message => {
                    console.log('received: %s', message);
                    message = JSON.parse(message);
                    if (message.method === 'prompt') {
                        ws.send(JSON.stringify({
                            data: '',
                            prompt: process.cwd() + '>',
                        }));
                    } else
                    if (message.method === 'key') {
                        if (message.key === '\u0003' && ws._process && ws._process.kill) {
                            ws._process.kill();
                        } else if (ws._stdin) {
                            ws._stdin.write(message.key, 'utf8');
                        }
                    } else
                    if (message.method === 'tab') {
                        const str = completion(message.start);
                        ws.send(JSON.stringify({completion: str}));
                    } else
                    if (message.method === 'command') {
                        if (message.command.startsWith('cd ')) {
                            const result = cd(message.command.substring(3));
                            if (result === true) {
                                ws.send(JSON.stringify({
                                    data: '',
                                    prompt: process.cwd() + '>',
                                }));
                            } else {
                                result.prompt = process.cwd() + '>';
                                ws.send(JSON.stringify(result));
                            }
                        } else if (message.command && !ws._isExecuting) {
                            ws._isExecuting = true;
                            ws.send(JSON.stringify({isExecuting: true}));

                            if (message.command === 'node') {
                                message.command += ' -i';
                            }

                            executeCommand(message.command, ws, code => {
                                ws._isExecuting = false;
                                ws.send(JSON.stringify({
                                    prompt: process.cwd() + '>',
                                    isExecuting: false,
                                }));
                            });
                        }
                    }
                });

                ws.on('close', function () {
                    if (ws && ws._process) {
                        try {
                            ws._process.kill();
                        } catch (e) {
                            // ignore
                        }
                        ws._process = null;
                        ws._stdin = null;
                    }

                    connectedCounter && connectedCounter--;
                    console.log('disconnected');
                    if (!connectedCounter) {
                        adapter.setState('info.connection', false, true);
                    }
                });

                ws.send(JSON.stringify({
                    prompt: process.cwd() + '>',
                }));

                console.log('connected');
            });
        });
    } else {
        adapter.log.error('port missing');
        adapter.terminate ? adapter.terminate(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION) : process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
    }

    return server;
}

async function main() {
    server = initWebServer(adapter.config);
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export startAdapter in compact mode
    module.exports = startAdapter;
} else {
    // otherwise start the instance directly
    startAdapter();
}