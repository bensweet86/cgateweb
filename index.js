#!/usr/bin/env node
const mqtt = require('mqtt')
const url = require('url');
const fs = require('fs');
const net = require('net');
const events = require('events');
const settings = require('./settings.js');
const parseString = require('xml2js').parseString;

let tree = '';
let treenet = 0;

let interval = {};
let commandInterval = {};
let eventInterval = {};
let clientConnected = false;
let commandConnected = false;
let eventConnected = false;
let buffer = "";
const eventEmitter = new events.EventEmitter();
const messageInterval = settings.messageinterval || 0;

const buildDeviceAddress = (cmd) => {
    const host = cmd.Host();
    const group = cmd.Group();
    const device = cmd.Device();
    if (!host || !group || !device) return null;
    return `${host}/${group}/${device}`;
};

const buildGroupAddress = (cmd) => {
    const host = cmd.Host();
    const group = cmd.Group();
    if (!host || !group) return null;
    return `${host}/${group}`;
};

const buildDeviceBase = (cmd) => {
    const cbusname = settings.cbusname;
    const deviceAddress = buildDeviceAddress(cmd);
    if (!cbusname || !deviceAddress) return null
    return `//${cbusname}/${deviceAddress}`;
}
const buildGroupBase = (cmd) => {
    const cbusname = settings.cbusname;
    const groupAddress = buildGroupAddress(cmd);
    if (!cbusname || !groupAddress) return null
    return `//${cbusname}/${groupAddress}`;
}

const cbusLevelQueue = {};
async function getCBusLevel(targetAddress, timeout = 2000) {

    if (cbusLevelQueue[targetAddress]) {
        return cbusLevelQueue[targetAddress]; // reuse existing request
    }

    cbusLevelQueue[targetAddress] = new Promise((resolve, reject) => {

        const handler = (addr, level) => {
            if (addr === targetAddress) {
                cleanup();
                resolve(level);
            }
        };

        const cleanup = () => {
            clearTimeout(timer);
            eventEmitter.removeListener('level', handler);
            delete cbusLevelQueue[targetAddress];
        };

        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Timeout waiting for level: ${targetAddress}`));
        }, timeout);

        eventEmitter.on('level', handler);
        commandMsg.write(`GET //${settings.cbusname}/${targetAddress} level\n`);
    });

    return cbusLevelQueue[targetAddress];
}

// MQTT URL
const protocol = settings.mqtt.tls ? 'mqtts' : 'mqtt';
const mqttUrl = `${protocol}://${settings.mqtt.host}:${settings.mqtt.port}`;

const mqttOptions = {
    port: settings.mqtt.port,
    host: settings.mqtt.host,
    qos: 0,
    clientId: 'cgateweb-mqtt',
    keepalive: 60,
    reconnectPeriod: 5000,
    connectTimeout: 30000,
    clean: true,
};

// Username and password
if(settings.mqttusername && settings.mqttpassword) {
    mqttOptions.username = settings.mqttusername;
    mqttOptions.password = settings.mqttpassword;
}

// TLS options
if (settings.mqtt.tls) {

    // A CA may have been provided for TLS or mTLS
    const caExists = fs.existsSync(settings.mqttcacrt);
    if (caExists) {
        mqttOptions.ca = fs.readFileSync(settings.mqttcacrt);
    }

    //mTLS options
    if (settings.mqtt.mtls) {
        try {
            const certExists = fs.existsSync(settings.mqttclientcrt);
            const keyExists = fs.existsSync(settings.mqttclientkey);

            //CA, client cert and client key are mandatory for mTLS
            if (!caExists || !certExists || !keyExists) {
                throw new Error(`MQTT TLS files missing: CA: ${caExists}, CERT: ${certExists}, KEY: ${keyExists}`);
            }

            mqttOptions.cert = fs.readFileSync(settings.mqttclientcrt);
            mqttOptions.key = fs.readFileSync(settings.mqttclientkey);
            mqttOptions.rejectUnauthorized = true;

            mqttOptions.passphrase = settings.mqttKeyPassphrase || undefined;

            mqttOptions.checkServerIdentity = (host, cert) => {
                const san = cert.subjectaltname || '';
                
                const regex = new RegExp(`DNS:.*\\b${host}\\b`);

                if (!regex.test(san) && cert.subject.CN !== host) {
                    throw new Error('MQTT broker certificate mismatch!');
                }
            };

            console.log('MQTT TLS certificates loaded successfully.');
        } catch (err) {
            console.error('Error loading MQTT TLS certificates:', err.message);
            process.exit(1);
        }
    }

    // Enforce TLS versions
    mqttOptions.minVersion = 'TLSv1.2';
}

const options = {};
if(settings.retainreads === true) {
    options.retain = true;
}

// Create an MQTT client connection
const client = mqtt.connect(mqttUrl, mqttOptions);
const command = new net.Socket();
const event = new net.Socket();

const queue = {
    publish: function(topic, payload, opts = {}, callback = ()=>{}) {
        queue.queue.push({ topic, payload, opts, callback });
        if(queue.interval === null) {
            queue.interval = setInterval(queue.process, messageInterval);
            queue.process();
        }
    },
    process: function() {
        if(queue.queue.length === 0) {
            clearInterval(queue.interval);
            queue.interval = null;
        } else {
            let msg = queue.queue.shift();
            if (logging) console.log(`MQTT publish: topic - ${msg.topic}, payload - ${msg.payload}`);
            client.publish(msg.topic, msg.payload, msg.opts, msg.callback);
        }
    },
    interval: null,
    queue: []
};

const commandMsg =    {
    write: function (value) {
        commandMsg.queue.push(value);
        if(commandMsg.interval === null) {
            commandMsg.interval = setInterval(commandMsg.process,messageInterval);
            commandMsg.process();
        }
    },
    process: function() {
        if(commandMsg.queue.length === 0) {
            clearInterval(commandMsg.interval);
            commandMsg.interval = null;
        } else {
            let msg = commandMsg.queue.shift();
            if (logging) console.log(`Cbus write: ${msg}`);
            command.write(msg);
        }
    },
    interval: null,
    queue:[]
};

const CBusEvent = function(data){
    const parts1 = data.toString().split(" ");
    const parts2 = parts1[0].toString().split("-");
    let address = [];
    let level = null;

    //Example: 300-//THUIS/254/56/3: level=0
    if(parts2.length > 1) {

        if (parts2[0] == "300") {
            //Separate the address HOST/GROUP/DEVICEID
            const trim = parts2[1].split(":");
            address = trim[0].split("/");
            level = (parts1[1].split("="))[1];
        } else {
            level = null;
        }

        this.DeviceType = () => null;
        this.Action = () => null;
        this.Response = () => parts2[0].toString();

    } else {
        //Example: "lighting on //THUIS/254/56/27    #sourceunit=201 OID=adccf7c0-b076-103c-8603-b219963e4d06 sessionId=cmd21 commandId={none}"
        //Example: "lighting ramp //THUIS/254/56/27 184 0 #sourceunit=201 OID=adccf7c0-b076-103c-8603-b219963e4d06 sessionId=cmd25 commandId={none}"
        //Example: "300 //THUIS/254/56/85: level=0"

        if (parts1[0] == "300") {
            const trim = parts1[1].split(":");
            address = trim[0].split("/");
            level = (parts1[2].split("="))[1];

        } else if (parts1.length > 2) {
            address = parts1[2].split("/");
            level = parts1[3];

        } else {
            level = null;
        }

        this.DeviceType = () => parts1[0] || null;
        this.Action = () => parts1[1] || null;
        this.Response = () => parts1[0].toString();
    }

    this.Host = function() { return address[3]?.toString() || null; };
    this.Group = function() { return address[4]?.toString() || null; };
    this.Device = function() { return address[5]?.toString() || null; };
 
    //Calculate the tree response
    this.Tree = () => (this.Response() === "347" ? parts1[1] + "\n" : "");

    this.Level = () => {

        //If set to "on" then this is 100
        if (this.Action() == "on") return "100";

        //If this is set to "off" then this is 0
        if (this.Action() == "off") return "0";
        
        if (!level) return null;

        //Extract the ramp value
        return Math.round(parseInt(level)*100/255).toString();
    };
};

const CBusCommand = function(topic, message){
    //Example: "cbus/write/254/56/7/switch ON"
    const parts = topic.toString().split("/");
    if (parts.length <= 5 ) return;

    //Separate split strings into Host/Group/DeviceID
    this.Host = () => parts[2]?.toString() || null;
    this.Group = () => parts[3]?.toString() || null;
    this.Device = () => parts[4]?.toString() || null;

    //Command type
    const commandParts = parts[5].split(' ');
    this.CommandType = () => (commandParts[0] || "").toLowerCase();

    //Action type
    this.Action = () => (commandParts[1] || "").toLowerCase();

    //Message
    this.Message = () => message?.toString() || "";
    
    //Ramp level
    this.Level = () => {
        const action = this.Action();

        //Ramp to 100 if value is "on"
        if (action === "on") return "100";

        //Ramp to 0 if value is "off"
        if (action === "off") return "0";

        const messageParts = this.Message().split(',');

        //Ramp value (TODO)
        if (messageParts.length > 1) {
            const num = parseInt(messageParts[1]);
            if (!isNaN(num)) return Math.round(num * 100 / 255).toString();
        }

        return null;
    };
};

const HOST = settings.cbusip;
const COMPORT = 20023;
const EVENTPORT = 20025;

const logging = settings.logging;

// Connect to cgate command port via telnet
command.connect(COMPORT, HOST);

// Connect to cgate event port via telnet
event.connect(EVENTPORT, HOST);

function started(){
    if(commandConnected && eventConnected && client.connected){
        console.log('ALL CONNECTED');
        if(settings.getallnetapp && settings.getallonstart) {
            console.log('Getting all values');
            commandMsg.write('GET //'+settings.cbusname+'/'+settings.getallnetapp+'/* level\n');
        }
        if(settings.getallnetapp && settings.getallperiod) {
            clearInterval(interval);
            setInterval(function(){
                console.log('Getting all values');
                commandMsg.write('GET //'+settings.cbusname+'/'+settings.getallnetapp+'/* level\n');
            },settings.getallperiod*1000);
        }
    }
}

client.on('disconnect', () => {
    clientConnected = false;
    console.log(`DISCONNECT FROM MQTT: ${JSON.stringify(settings.mqtt)}`);
});

client.on('error', (err) => {
    clientConnected = false;
    console.error('MQTT ERROR', err);
});

client.on('offline', () => {
    clientConnected = false;
    console.log(`MQTT OFFLINE: ${JSON.stringify(settings.mqtt)}`);
});

client.on('reconnect', () => {
    clientConnected = false;
    console.log(`MQTT RECONNECTING: ${JSON.stringify(settings.mqtt)}`);
});

client.on('connect', (connack) => {
    console.log(`MQTT CONNECTED: ${JSON.stringify(settings.mqtt)}`, JSON.stringify(connack, null, 2));
    clientConnected = true;

    client.subscribe('cbus/write/#', (err, granted) => {
        if (err) {
            console.error('MQTT Subscribe failed', err);
            return;
        }
        console.log('MQTT Subscription successful', granted);
        started();
    });

});

client.on('message', async (topic, message) => {
    if (logging) console.log(`Message received on ${topic} : ${message}`);
    
    const command = new CBusCommand(topic, message);
    const cmdType = command.CommandType();
        
    const address = buildDeviceAddress(command);
    const groupBase = buildGroupBase(command);
    const deviceBase = buildDeviceBase(command);
    const msgStr = message.toString().trim().toUpperCase();

    switch(cmdType) {

        // Get updates from all groups
        case "gettree":
            treenet = command.Host();
            commandMsg.write(`TREEXML ${command.Host()}\n`);
            break;

        // Get updates from all groups
        case "getall":
            commandMsg.write(`GET ${groupBase}/* level\n`);
            break;

        // On/Off control
        case "switch":
            if(msgStr == "ON") commandMsg.write(`ON ${deviceBase}\n`);
            if(msgStr == "OFF") commandMsg.write(`OFF ${deviceBase}\n`);
            if(msgStr == "RAMP") commandMsg.write(`RAMP ${deviceBase} ${command.Level()}\n`);
            break;

        // Ramp, increase/decrease, on/off 
        case "ramp":
            try {
                switch(msgStr) {
                    case "INCREASE":
                    case "DECREASE": {
                        const level = await getCBusLevel(address);

                        const newLevel =
                            msgStr === "INCREASE"
                                ? Math.min(level + 26, 255)
                                : Math.max(level - 26, 0);

                        commandMsg.write(`RAMP ${deviceBase} ${newLevel}\n`);
                        break;
                    }

                    case "TERMINATERAMP":
                        commandMsg.write(`TERMINATERAMP ${deviceBase}\n`);
                        break;

                    case "ON":
                        commandMsg.write(`ON ${deviceBase}\n`);
                        break;

                    case "OFF":
                        commandMsg.write(`OFF ${deviceBase}\n`);
                        break;

                    default:
                        const ramp = msgStr.split(",");
                        const num = Math.round(parseInt(ramp[0])*255/100);

                        if (!isNaN(num) && num < 256) {
                            if (ramp.length > 1) {
                                commandMsg.write(`RAMP ${deviceBase} ${num} ${ramp[1]}\n`);
                            } else {
                                commandMsg.write(`RAMP ${deviceBase} ${num}\n`);
                            }
                        } else {
                            console.warn(`Invalid ramp value: ${msgStr}`);
                        }
                }
            } catch (err) {
                console.error(`Ramp failed for ${address}:`, err.message);
            }
        break;

        // HVAC control added by Marty.    See thermostats.vb script on formatting of the MQTT payload.    
        // You will need to write your own script to format the MQTT payload from you particular home automtion system.
        // The the document "C-Gate Air-Conditioning Application User Guide.pdf" from Clipsal to understand the exact format.
            
        // HVAC requires the entire cgate command to be formatted (see C-Gate Air-Conditioning Application User Guide for details)
        // e.g. "aircon set_zone_hvac_mode //HOME/254/172 5 0 1 0 0 0 1 8 4352 0"
        // To get this to work you would send cbus/write/254/172/1/hvac=payload where payload is the data after cbus network address
        // This script uses 'hvac' (part[5]) to trigger the case below
        // So e.g. MQTT message would be "cbus/write/254/172/1/hvac=5 0 1 0 0 0 1 8 4352 0" which would send "AIRCON SET_ZONE_HVAC_MODE //HOME/254/172 5 0 1 0 0 0 1 8 4352 0" to cgate
        // The payload needs to be formatted correctly by the sending software (e.g Homeseer needs to send "5 0 1 0 0 0 1 8 4352 0")....see the thermostats.vb script.
        // Make sure there is nothing in the 'publish payload' in mcsMQTT for HomeSeer
        case "hvac":
            if (logging) console.log('HVAC Event data: ' + 'AIRCON SET_ZONE_HVAC_MODE //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+" "+msgStr+'\n');
            commandMsg.write('AIRCON SET_ZONE_HVAC_MODE //'+settings.cbusname+'/'+command.Host()+'/'+command.Device()+" "+msgStr+'\n');                                        
            break;

        default:
    }
    
});

// publish a message to a topic
queue.publish('hello/world', 'CBUS ON');

command.on('error',function(err){
    console.log(`COMMAND ERROR: ${JSON.stringify(err)}`);
});

event.on('error',function(err){
    console.log(`EVENT ERROR: ${JSON.stringify(err)}`);
});

command.on('connect',function(err){
    commandConnected = true;
    console.log(`CONNECTED TO C-GATE COMMAND PORT: ${HOST}:${COMPORT}`);
    commandMsg.write('EVENT ON\n');
    started();
    clearInterval(commandInterval);
});

event.on('connect',function(err){
    eventConnected = true;
    console.log(`CONNECTED TO C-GATE EVENT PORT: ${HOST}:${EVENTPORT}`);
    started();
    clearInterval(eventInterval);
});

command.on('close',function(){
    commandConnected = false;
    console.log('COMMAND PORT DISCONNECTED');
    commandInterval = setTimeout(function(){
        console.log('COMMAND PORT RECONNECTING...');
        command.connect(COMPORT, HOST);
    },10000);
});

event.on('close',function(){
    eventConnected = false;
    console.log('EVENT PORT DISCONNECTED');
    eventInterval = setTimeout(function(){
        console.log('EVENT PORT RECONNECTING...');
        event.connect(EVENTPORT, HOST);
    },10000);
});

command.on('data',function(data) {
    if (logging) console.log(`Command data: ${data}`);
    let lines = (buffer+data.toString()).split("\n");
    buffer = lines[lines.length-1];
    let action = null;

    if (lines.length > 1) {
        for (let i = 0;i<lines.length-1;i++) {
            action = new CBusEvent(lines[i]);
            const address = buildDeviceAddress(action);

            if(action.Response() == "300") {
                if (action.Level() == 0) {
                    if (logging) console.log(`C-Bus status received: ${address} OFF`);
                    if (logging) console.log(`C-Bus status received: ${address} 0%`);
                    queue.publish(`cbus/read/${address}/state`, `OFF`, options, function() {});
                    queue.publish(`cbus/read/${address}/level`, `0`, options, function() {});
                    eventEmitter.emit('level', address, 0);
                } else {
                    if (logging) console.log(`C-Bus status received: ${address} ON`);
                    if (logging) console.log(`C-Bus status received: ${address} ${action.Level()}%`);
                    queue.publish(`cbus/read/${address}/state`, `ON`, options, function() {});
                    queue.publish(`cbus/read/${address}/level`, action.Level(), options, function() {});
                    eventEmitter.emit('level', address, action.Level());
                }
            } else if(action.Response() == "347"){
                tree += action.Tree();
            } else if(action.Response() == "343"){
                tree = '';
            }    else if(action.Response() == "344"){
                parseString(tree, function (err, result) {
                    try{
                        if (logging === true) console.log(`C-Bus tree received: ${JSON.stringify(result)}`);
                        queue.publish(`cbus/read/${treenet}///tree`, options, JSON.stringify(result));
                    }catch(err){
                        console.log(err);
                    }
                    tree = '';
                });
            }
        }
    }
});


// Add a 'data' event handler for the client socket
// data is what the server sent to this socket
event.on('data', function(data) {
        if (logging) console.log(`Event data: ${data}`);
        data.toString().split(/\r?\n/).forEach(line =>    {
                if (logging) console.log(`Event line: ${line}`);
                let parts = line.split(" ");
                let action = new CBusEvent(line);
                const address = buildDeviceAddress(action);

                if(action.DeviceType() == "lighting") {

                    switch(action.Action()) {
                        case "on":
                            if (logging) console.log(`C-Bus status received: ${address} ON`);
                            if (logging) console.log(`C-Bus status received: ${address} 100%`);
                            queue.publish(`cbus/read/${address}/state`, `ON`, options, function() {});
                            queue.publish(`cbus/read/${address}/level`, `100`, options, function() {});
                            break;
                        case "off":
                            if (logging) console.log(`C-Bus status received: ${address} OFF`);
                            if (logging) console.log(`C-Bus status received: ${address} 0%`);
                            queue.publish(`cbus/read/${address}/state`, `OFF`, options, function() {});
                            queue.publish(`cbus/read/${address}/level`, `0`, options, function() {});
                            break;
                        case "ramp":
                            if(parseInt(parts[3]) > 0) {
                                if (logging) console.log(`C-Bus status received: ${address} ON`);
                                if (logging) console.log(`C-Bus status received: ${address} ${action.Level().toString()}%`);
                                queue.publish(`cbus/read/${address}/state`, `ON`, options, function() {});
                                queue.publish(`cbus/read/${address}/level`, action.Level().toString(), options, function() {});
                            } else {
                                if (logging) console.log(`C-Bus status received: ${address} OFF`);
                                if (logging) console.log(`C-Bus status received: ${address} 0%`);
                                queue.publish(`cbus/read/${address}/state`, `OFF`, options, function() {});
                                queue.publish(`cbus/read/${address}/level`, `0`, options, function() {});
                            }
                            break;
                        default:
                    } 
                }
                    
                // MM Added this section to handle incoming thermostat data, use 'cbust' (cbus thermostat) instead of cbus for the first part of the published topic
                // e.g the MQTT topic will be something like "cbust/read/254/172/zone5mode" for zone 5 mode

                // e.g. C-Bus event "aircon set_zone_hvac_mode //HOME/254/172 5 0 1 0 0 0 1 8 5376 0 #sourceunit=20 OID=ffaea850-28ee-1037-90ab-8cce18a03d68"

                // Note that status only messages start with a # so the parts will have an extra part at the start i.e. #
                // e.g. C-Bus event "# aircon zone_temperature //HOME/254/172 1 0,1,2 5438 0 #sourceunit=15 OID=ffaea850-28ee-1037-90ab-8cce18a03d68"

                // Note that to get the temp in degrees celcius you have to divide by 255

                // Zone temperature and zone status are sent by the thermostats at regular intervals and are read only
        //todo
                else if(parts[0] == "#") {
                    address_zone = parts[3].split("/");
                    switch(parts[2]) {
                        case "zone_temperature":
                            if (logging) { console.log('C-Bus thermostat status received: ' + address_zone[3] + '/' + action.Group() + ' zone_temperature: ' + Math.round(parseInt(parts[6]) / 255).toString()); }
                            queue.publish('cbust/read/'+address_zone[3]+'/'+action.Group()+'/zone'+parts[4]+'temp' , Math.round(parseInt(parts[6])/255).toString(),options, function() {});
                            break;
                        case "zone_hvac_plant_status":
                            if (logging) { console.log('C-Bus thermostat status received: ' + address_zone[3] + '/' + action.Group() + ' zone_hvac_plant_status: ' + parts);}
                            queue.publish('cbust/read/'+address_zone[3]+'/'+action.Group()+'/zone'+parts[4]+'status' , parts[7],options, function() {});
                            break;
                        default:
                    }
                }
//todo
                // Zone mode, setback and settemp can be sent to the thermostats.    This section reads the incoming C-Bus message and converts to a MQTT message
                // If the mode is OFF then the settemp will always be 0.    This means in your HA settemp will always reset to 0 when the thermostat is off.
                else if(parts[0] == "aircon") {
                    address = parts[2].split("/");
                    switch(parts[1]) {
                        case "set_zone_hvac_mode":
                            if (logging) {console.log('C-Bus thermostat status received: '+address[3] +'/'+action.Group()+' set_zone_havc_mode: '+parts);}
                            queue.publish('cbust/read/'+address[3]+'/'+action.Group()+'/zone'+parts[3]+'mode' , parts[5],options, function() {});
                            queue.publish('cbust/read/'+address[3]+'/'+action.Group()+'/zone'+parts[3]+'setback' , parts[7],options, function() {});
                            queue.publish('cbust/read/'+address[3]+'/'+action.Group()+'/zone'+parts[3]+'settemp' , Math.round(parseInt(parts[11])/256).toString(),options, function() {});
                            break;
                        default:
                    }
                }
        });
});