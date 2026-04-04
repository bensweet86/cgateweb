
//cbus ip address
exports.cbusip = '10.0.0.5';


//cbus project name
//exports.cbusname = "HOME";
exports.cbusname = "THUIS";

//mqtt settings
exports.mqtt = {
  host: '10.0.0.5',
  port: 8884,
  tls: true,
  mtls: true
};

//if mTLS is going to be used then CA, Client CA & Client Key need to be provided in a file
exports.mqttcacrt = 'D:/Source/cgateweb/certs/ca.crt'
exports.mqttclientcrt = 'D:/Source/cgateweb/certs/cgateweb.crt'
exports.mqttclientkey = 'D:/Source/cgateweb/certs/cgateweb.key'

//username and password (unncomment to use)
//exports.mqttusername = 'username1';
//exports.mqttpassword = 'password1';

// net and app for automatically requesting values
// exports.getallnetapp = '254/56';
exports.getallnetapp = '254/56';

// whether to request on start (requires getallnetapp set as well)
// exports.getallonstart = true;
exports.getallonstart = true;

// how often to request after start (in seconds), (requires getallnetapp set as well)
// exports.getallperiod = 60*60;
exports.getallperiod = 60*60;

// Sets MQTT retain flag for values coming from cgate
exports.retainreads = true;

exports.messageinterval = 200;

//logging
//exports.logging = false;
exports.logging = true;
