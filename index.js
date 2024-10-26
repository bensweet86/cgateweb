#!/usr/bin/env node
var mqtt = require('mqtt'), url = require('url');
var net = require('net');
var events = require('events');
var settings = require('./settings.js');
var parseString = require('xml2js').parseString;

var options = {};
if(settings.retainreads === true) {
    options.retain = true;
}

var tree = '';
var treenet = 0;

var interval = {};
var commandInterval = {};
var eventInterval = {};
var clientConnected = false;
var commandConnected = false;
var eventConnected = false;
var buffer = "";
var eventEmitter = new events.EventEmitter();
var messageinterval = settings.messageinterval || 0;

// MQTT URL
var mqtt_url = url.parse('mqtt://'+settings.mqtt);

// Username and password
var OPTIONS = {};
if(settings.mqttusername && settings.mqttpassword) {
  OPTIONS.username = settings.mqttusername;
  OPTIONS.password = settings.mqttpassword;
}

// Create an MQTT client connection
var client = mqtt.createClient(mqtt_url.port, mqtt_url.hostname,OPTIONS);
var command = new net.Socket();
var event = new net.Socket();

var queue =  {
  publish: function (topic, payload ) {
    queue.queue.push({topic:topic,payload:payload});
    if(queue.interval === null) {
      queue.interval = setInterval(queue.process,messageinterval);
      queue.process();
    }
  },
  process: function() {
    if(queue.queue.length === 0) {
      clearInterval(queue.interval);
      queue.interval = null;
    } else {
      var msg = queue.queue.shift();
      if (logging == true) {console.log('MQTT publish: topic - ' + msg.topic + ', payload - ' + msg.payload);}
      client.publish(msg.topic,msg.payload);
    }
  },
  interval: null,
  queue:[]
};

var commandMsg =  {
  write: function (value) {
    commandMsg.queue.push(value);
    if(commandMsg.interval === null) {
      commandMsg.interval = setInterval(commandMsg.process,messageinterval);
      commandMsg.process();
    }
  },
  process: function() {
    if(commandMsg.queue.length === 0) {
      clearInterval(commandMsg.interval);
      commandMsg.interval = null;
    } else {
      var msg = commandMsg.queue.shift();
      if (logging == true) {console.log('Cbus write: ' + msg);}
      command.write(msg);
    }
  },
  interval: null,
  queue:[]
};

var CBusEvent = function(data){
  var parts1;
  var parts2;
  var address;
  var trim;
  var level;

  parts1 = data.toString().split(" ");
  parts2 = parts1[0].toString().split("-");

  //Example: 300-//THUIS/254/56/3: level=0
  if(parts2.length > 1) {

    if (parts2[0] == "300") {
      //Separate the address HOST/GROUP/DEVICEID
      trim = parts2[1].split(":");
      address = trim[0].split("/");
      level = (parts1[1].split("="))[1];
    } else {
      level = null;
    }

    this.DeviceType = function(){ return null; };
    this.Action = function(){ return null; };
    this.Response = function(){ return parts2[0].toString(); };

  } else {
    //Example: "lighting on //THUIS/254/56/27  #sourceunit=201 OID=adccf7c0-b076-103c-8603-b219963e4d06 sessionId=cmd21 commandId={none}"
    //Example: "lighting ramp //THUIS/254/56/27 184 0 #sourceunit=201 OID=adccf7c0-b076-103c-8603-b219963e4d06 sessionId=cmd25 commandId={none}"
    //Example: "300 //THUIS/254/56/85: level=0"

    if (parts1[0] == "300") {
      trim = parts1[1].split(":");
      address = trim[0].split("/");
      level = (parts1[2].split("="))[1];

    } else if (parts1.length > 2) {
      address = parts1[2].split("/");
      level = parts1[3];

    } else {
      level = null;
    }

    //Device type
    this.DeviceType = function(){ return parts1[0]; };

    //Action type
    this.Action = function(){ return parts1[1]; };

    this.Response = function(){ return parts1[0].toString(); };
  }

  this.Host = function(){ return address[3].toString(); };
  this.Group = function(){ return address[4].toString(); };
  this.Device = function(){ return address[5].toString(); };
 
  var _this = this;

  //Calculate the tree response
  this.Tree = function(){
    if (_this.Response() == 347){
      return parts1[1]+'\n';
    } else {
      return '';
    }
  };

  this.Level = function(){ 
    //If set to "on" then this is 100
    if (_this.Action() == "on"){
      return "100";
    } 
    //If this is set to "off" then this is 0
    else if (_this.Action() == "off"){
      return "0";
    }
    //Extract the ramp value
    else {
      return Math.round(parseInt(level)*100/255).toString();
    }
  };
};

var CBusCommand = function(topic, message){
  //Example: "cbus/write/254/56/7/switch ON"
  var parts = topic.toString().split("/");
  if (parts.length <= 5 ) return;

  //Separate split strings into Host/Group/DeviceID
  this.Host = function(){ return parts[2].toString(); };
  this.Group = function(){ return parts[3].toString(); };
  this.Device = function(){ return parts[4].toString(); };

  //Command type
  var commandParts = parts[5].split(' ');
  this.CommandType = function(){ return commandParts[0].toLowerCase(); };

  //Action type
  this.Action = function(){ return commandParts[0].toLowerCase(); };

  //Message
  this.Message = function(){ return message.toString(); };
  
  //Ramp level
  var _this = this;
  this.Level = function(){ 
    //Ramp to 100 if value is "on"
    if (_this.Action() == "on"){
      return "100";
    } 

    //Ramp to 0 if value is "off"
    else if (_this.Action() == "off"){
      return "0";
    } 
    
    else {
      //Ramp value (TODO)
      var messageParts = _this.Message().split(',');
      if (messageParts.length > 1){
        return Math.round(parseInt(messageParts[1])*100/255).toString();
      }
    }
    
    
  };
};

var HOST = settings.cbusip;
var COMPORT = 20023;
var EVENTPORT = 20025;

var logging = settings.logging;

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

client.on('disconnect',function(){
  clientConnected = false;
});

client.on('connect', function() { // When connected
  clientConnected = true;
  console.log('CONNECTED TO MQTT: ' + settings.mqtt);
  started();

  // Subscribe to MQTT
  client.subscribe('cbus/write/#', function() {

    // when a message arrives, do something with it
    client.on('message', function(topic, message, packet) {
      if (logging == true) {console.log('Message received on ' + topic + ' : ' + message);}

      var command = new CBusCommand(topic, message);
      switch(command.CommandType()) {

        // Get updates from all groups
        case "gettree":
          treenet = command.Host;
          commandMsg.write('TREEXML '+command.Host()+'\n');
          break;

        // Get updates from all groups
        case "getall":
          commandMsg.write('GET //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/* level\n');
          break;

        // On/Off control
        case "switch":

          if(command.Message() == "ON") {commandMsg.write('ON //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+'\n');}
          if(command.Message() == "OFF") {commandMsg.write('OFF //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+'\n');}
          if(command.Message() == "RAMP") { commandMsg.write('RAMP //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' '+command.Level()+'\n');}
          break;

        // Ramp, increase/decrease, on/off 
        //TODO, still some bits to test and simplify
        case "ramp":
            message = String(message);
            switch(message.toUpperCase()) {
            case "INCREASE":
              eventEmitter.on('level',function increaseLevel(address,level) {
                if (address == command.Host()+'/'+command.Group()+'/'+command.Device()) {
                  commandMsg.write('RAMP //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' '+Math.min((level+26),255)+' '+'\n');
                  eventEmitter.removeListener('level',increaseLevel);
                }
              });
              commandMsg.write('GET //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' level\n');
              break;

            case "DECREASE":
              eventEmitter.on('level',function decreaseLevel(address,level) {
                if (address == command.Host()+'/'+command.Group()+'/'+command.Device()) {
                  commandMsg.write('RAMP //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' '+Math.max((level-26),0)+' '+'\n');
                  eventEmitter.removeListener('level',decreaseLevel);
                }
              });
              commandMsg.write('GET //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' level\n');
              break;

            case "TERMINATERAMP":
              eventEmitter.on('level',function terminateRamp(address) {
                if (address == command.Host()+'/'+command.Group()+'/'+command.Device()) {
                  commandMsg.write('TERMINATERAMP //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+'\n');
                  eventEmitter.removeListener('level',terminateRamp);
                }
              });
              commandMsg.write('GET //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' level\n');
              break;

            case "ON":
              commandMsg.write('ON //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+'\n');
              break;

            case "OFF":
              commandMsg.write('OFF //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+'\n');
              break;

            default:
              //TODO still some bits to review and simplify
              var ramp = message.split(",");
              var num = Math.round(parseInt(ramp[0])*255/100);
              if (!isNaN(num) && num < 256) {

                if (ramp.length > 1) {
                  commandMsg.write('RAMP //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' '+num+' '+ramp[1]+'\n');
                } else {
                  commandMsg.write('RAMP //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+'/'+command.Device()+' '+num+'\n');
                }
              }
          }
          break;

          // HVAC control added by Marty.  See thermostats.vb script on formatting of the MQTT payload.  
			    // You will need to write your own script to format the MQTT payload from you particular home automtion system.
			    // The the document "C-Gate Air-Conditioning Application User Guide.pdf" from Clipsal to understand the exact format.
			
          // HVAC requires the entire cgate command to be formatted (see C-Gate Air-Conditioning Application User Guide for details)
          // e.g. "aircon set_zone_hvac_mode //HOME/254/172 5 0 1 0 0 0 1 8 4352 0"
          // To get this to work you would send cbus/write/254/172/1/hvac=payload where payload is the data after cbus network address
          // This script uses 'hvac' (part[5]) to trigger the case below
          // So e.g. MQTT message would be "cbus/write/254/172/1/hvac=5 0 1 0 0 0 1 8 4352 0" which would send "AIRCON SET_ZONE_HVAC_MODE //HOME/254/172 5 0 1 0 0 0 1 8 4352 0" to cgate
          // The payload needs to be formatted correctly by the sending software (e.g Homeseer needs to send "5 0 1 0 0 0 1 8 4352 0")....see the thermostats.vb script.
			  	// Make sure there is nothing in the 'publish payload' in mcsMQTT for HomeSeer
               //todo
          case "hvac":
            if (logging == true) { console.log('HVAC Event data: ' + 'AIRCON SET_ZONE_HVAC_MODE //'+settings.cbusname+'/'+command.Host()+'/'+command.Group()+" "+message+'\n'); }
            command.write('AIRCON SET_ZONE_HVAC_MODE //'+settings.cbusname+'/'+command.Host()+'/'+command.Device()+" "+message+'\n');                    
            break;

        default:
      }
    });
  });

  // publish a message to a topic
  queue.publish('hello/world', 'CBUS ON', function() {
  });
});

command.on('error',function(err){
  console.log('COMMAND ERROR:'+JSON.stringify(err));
});

event.on('error',function(err){
  console.log('EVENT ERROR:'+JSON.stringify(err));
});

command.on('connect',function(err){
  commandConnected = true;
  console.log('CONNECTED TO C-GATE COMMAND PORT: ' + HOST + ':' + COMPORT);
  commandMsg.write('EVENT ON\n');
  started();
  clearInterval(commandInterval);
});

event.on('connect',function(err){
  eventConnected = true;
  console.log('CONNECTED TO C-GATE EVENT PORT: ' + HOST + ':' + EVENTPORT);
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
  if (logging == true) {console.log('Command data: ' + data);}
  var lines = (buffer+data.toString()).split("\n");
  buffer = lines[lines.length-1];
  var action = null;

  if (lines.length > 1) {
    for (i = 0;i<lines.length-1;i++) {
      action = new CBusEvent(lines[i]);

      if(action.Response() == "300") {
        if (action.Level() == 0) {
          if (logging == true) {console.log('C-Bus status received: '+action.Host() +'/'+action.Group()+'/'+action.Device()+' OFF');}
          if (logging == true) {console.log('C-Bus status received: '+action.Host() +'/'+action.Group()+'/'+action.Device()+' 0%');}
          queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/state' , 'OFF',options, function() {});
          queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/level' , '0',options, function() {});
          eventEmitter.emit('level',action.Host()+'/'+action.Group()+'/'+action.Device(),0);
        } else {
          if (logging == true) {console.log('C-Bus status received: '+action.Host()+'/'+action.Group()+'/'+action.Device()+' ON');}
          if (logging == true) {console.log('C-Bus status received: '+action.Host()+'/'+action.Group()+'/'+action.Device()+' '+action.Level()+'%');}
          queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/state' , 'ON',options, function() {});
          queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/level' ,action.Level(),options, function() {});
          eventEmitter.emit('level',action.Host()+'/'+action.Group()+'/'+action.Device(),action.Level());
        }
      } else if(action.Response() == "347"){
        tree += this.Tree();
      } else if(action.Response() == "343"){
        tree = '';
      }  else if(action.Response() == "344"){
        parseString(tree, function (err, result) {
          try{
            if(logging === true) {console.log("C-Bus tree received:"+JSON.stringify(result));}
            queue.publish('cbus/read/'+treenet+'///tree',JSON.stringify(result));
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
    if (logging == true) {console.log('Event data: ' + data);}
    data.toString().split(/\r?\n/).forEach(line =>  {
        if (logging == true) {console.log('Event line: ' + line);}
        var parts = line.split(" ");
        var action = new CBusEvent(line);

        if(action.DeviceType() == "lighting") {

          switch(action.Action()) {
            case "on":
              if (logging == true) {console.log('C-Bus status received: '+action.Host()+'/'+action.Group()+'/'+action.Device()+' ON');}
              if (logging == true) {console.log('C-Bus status received: '+action.Host()+'/'+action.Group()+'/'+action.Device()+' 100%');}
              queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/state' , 'ON',options, function() {});
              queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/level' , '100',options, function() {});
              break;
            case "off":
              if (logging == true) {console.log('C-Bus status received: '+action.Host()+'/'+action.Group()+'/'+action.Device()+' OFF');}
              if (logging == true) {console.log('C-Bus status received: '+action.Host()+'/'+action.Group()+'/'+action.Device()+' 0%');}
              queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/state' , 'OFF',options, function() {});
              queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/level' , '0',options, function() {});
              break;
            case "ramp":
              if(parseInt(parts[3]) > 0) {
              if (logging == true) {console.log('C-Bus status received: '+action.Host()+'/'+action.Group()+'/'+action.Device()+' ON');}
              if (logging == true) {console.log('C-Bus status received: '+action.Host()+'/'+action.Group()+'/'+action.Device()+' '+action.Level().toString()+'%');}
                queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/state' , 'ON',options, function() {});
                queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/level' , action.Level().toString(),options, function() {});
              } else {
              if (logging == true) {console.log('C-Bus status received: '+action.Host()+'/'+action.Group()+'/'+action.Device()+' OFF');}
              if (logging == true) {console.log('C-Bus status received: '+action.Host()+'/'+action.Group()+'/'+action.Device()+' 0%');}
                queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/state' , 'OFF',options, function() {});
                queue.publish('cbus/read/'+action.Host()+'/'+action.Group()+'/'+action.Device()+'/level' , '0',options, function() {});
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
          address = parts[3].split("/");
          switch(parts[2]) {
            case "zone_temperature":
              if (logging == true) { console.log('C-Bus thermostat status received: ' + address[3] + '/' + action.Group() + ' zone_temperature: ' + Math.round(parseInt(parts[6]) / 255).toString()); }
              queue.publish('cbust/read/'+address[3]+'/'+action.Group()+'/zone'+parts[4]+'temp' , Math.round(parseInt(parts[6])/255).toString(),options, function() {});
              break;
            case "zone_hvac_plant_status":
              if (logging == true) { console.log('C-Bus thermostat status received: ' + address[3] + '/' + action.Group() + ' zone_hvac_plant_status: ' + parts);}
              queue.publish('cbust/read/'+address[3]+'/'+action.Group()+'/zone'+parts[4]+'status' , parts[7],options, function() {});
              break;
            default:
          }
        }
//todo
        // Zone mode, setback and settemp can be sent to the thermostats.  This section reads the incoming C-Bus message and converts to a MQTT message
        // If the mode is OFF then the settemp will always be 0.  This means in your HA settemp will always reset to 0 when the thermostat is off.
        else if(parts[0] == "aircon") {
          address = parts[2].split("/");
          switch(parts[1]) {
            case "set_zone_hvac_mode":
              if (logging == true) {console.log('C-Bus thermostat status received: '+address[3] +'/'+action.Group()+' set_zone_havc_mode: '+parts);}
              queue.publish('cbust/read/'+address[3]+'/'+action.Group()+'/zone'+parts[3]+'mode' , parts[5],options, function() {});
              queue.publish('cbust/read/'+address[3]+'/'+action.Group()+'/zone'+parts[3]+'setback' , parts[7],options, function() {});
              queue.publish('cbust/read/'+address[3]+'/'+action.Group()+'/zone'+parts[3]+'settemp' , Math.round(parseInt(parts[11])/256).toString(),options, function() {});
              break;
            default:
          }
        }
    });
});