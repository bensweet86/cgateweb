
//cbus ip address
//exports.cbusip = '127.0.0.1';
exports.cbusip = '10.0.0.5';


//cbus project name
//exports.cbusname = "HOME";
exports.cbusname = "THUIS";

//mqtt server ip:port
//exports.mqtt = '127.0.0.1:1883';
exports.mqtt = '10.0.0.5:1883';

//username and password (unncomment to use)
//exports.mqttusername = 'user1';
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
// exports.retainreads = true;

exports.messageinterval = 200;

//logging
//exports.logging = false;
exports.logging = true;
