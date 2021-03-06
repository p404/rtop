var fs         = require('fs'),
    join       = require('path').join,
    basename   = require('path').basename,
    inherits   = require('util').inherits,
    Connection = require('ssh2'),
    Emitter    = require('events').EventEmitter;

var debugging  = process.env.DEBUG,
    debug      = debugging ? console.log : function() { /* noop */ };

var get_key = function() {
  var keys = ['id_rsa', 'id_dsa'];

  for (var i in keys) {
    var file = join(process.env.HOME, '.ssh', keys[i]);
    if (fs.existsSync(file))
      return fs.readFileSync(file);
  }
}

var stats = {
  uptime: "uptime",
  cpu  : "top -bn 2 -d 0.3 | grep '^%\\?Cpu.s.' | tail -1 | awk '{print $2+$4+$6 \"%\"}'",
  ram  : "free | egrep 'Mem|buffers' | tr -d '\\n' | awk '{print $14*100/$7 \"%\"}'",
  ram  : "cat /proc/meminfo | head | tr -d '\\n' | awk '{print ($2-$4-$8-$10)*100/$2}'",
  disk : "df -lh | grep '% /$' | awk '{print $5}'",
  processes: "ps axw o %cpu,%mem,start_time,cmd | egrep -v 'grep|\\%CPU' | sed -e 's/ *$//g' -e 's/ \\([a-z\\/\\.-]*\\/\\)/ /g' | sort -n | tail -15 | tr '\\n' '@'",
}

var poll_command = function(interval) {
  var list = [];

  for (var key in stats) {
    var cmd = 'host_' + key + '=$(' + stats[key] + ')';
    list.push(cmd);
  }

  list.push('echo $host_uptime == $host_cpu == $host_ram == $host_disk == $host_processes');
  return 'while sleep ' + interval + '; do ' + list.join(' && ') + '; done';
}

var Remote = function(host, opts) {
  var opts = opts || {};

  this.connected = false;
  this.user = host.match('@') ? host.split('@')[0] : opts.user || process.env.USER;
  this.port = host.match(':') ? host.split(':')[1] : opts.port || 22;
  this.host = host.match(/(\w+@)?([^:]+)/)[2];
  this.key  = opts.key;
  this.key_path = opts.key_path;
}

inherits(Remote, Emitter);

Remote.prototype.connect = function(done) {

  var self = this,
      ssh  = new Connection();

  debug('Connecting to ' + this.host + ':' + this.port + ' as ' + this.user);

  ssh.connect({
    readyTimeout : 30000,
    host         : this.host,
    port         : this.port,
    compress     : true,
    username     : this.user,
    privateKey   : this.key || get_key(this.key_path),
    agentForward : true,
    agent        : process.env['SSH_AUTH_SOCK']
  });

  ssh.on('error', function(err) {
    // debug('Connection error: ' + err.message);
    done(err);
  });

  ssh.on('end', function() {
    self.connected = false;
    debug('Disconnected from ' + self.host);
  });

  ssh.on('close', function(had_error) {
    // c.debug('Connection stream closed. Had error: ' + had_error);
  });

  ssh.on('ready', function() {
    debug('Connected to ' + self.host);
    self.connected = true;
    done();
  })

  this.connection = ssh;
}

Remote.prototype.start = function(cb) {
  var self = this;

  self.connect(function(err) {
    cb(err);

    if (!err) self.poll();
  })
}

Remote.prototype.poll = function(interval) {

  var self     = this,
      interval = interval || '2.5';

  var parse = function(data) {
    debug('Got data: ' + data.toString());

    var split = data.toString().split('== ');
    if (!split[1]) return;

    self.current_uptime = split[0];
    self.cpu_usage      = parseFloat(split[1]);
    self.mem_usage      = parseFloat(split[2]);
    self.disk_usage     = parseFloat(split[3]);
    self.process_list   = parseProcesses(split[4]);

    self.emit('update', data.toString());
  }

  var parseProcesses = function(str) {
    if (!str) return [];

    return str.trim().split('@')
      .filter(function(el) { return el.trim() != '' })
      .map(function(line) {
        var arr = line.trim().split(' ');

        return {
          cpu     : arr.shift(),
          mem     : arr.shift(),
          start   : arr.shift(),
          process : (arr.join(' ')).trim()
        }
    }).reverse();
  }

  this.connection.exec(poll_command(interval), { pty: true }, function(err, child) {
    if (err) return self.stop();

    child.on('end', function() {
      self.stop();
    });

    child.on('data', parse);
  });

}

/*
Remote.prototype.close_stream = function() {
  debug('Closing stream...');
  this.stream.exit();
}

Remote.prototype.stream_closed = function() {
  debug('Stream closed.');
  this.disconnect();
}
*/

Remote.prototype.stop = function(cb) {
  // if (this.stream)
  //   this.close_stream(); // should trigger the stream_ended method
  if (this.connected)
    this.disconnect(function() { cb && cb() });
  else
    cb();
}

Remote.prototype.disconnect = function(cb) {
  debug('Disconnecting...');
  this.connection.on('end', cb);
  this.connection.end();
}

Remote.prototype.uptime = function() {
  return this.connected ? this.current_uptime : null;
}

Remote.prototype.cpu = function() {
  return this.connected ? this.cpu_usage : null;
}

Remote.prototype.mem = function() {
  return this.connected ? this.mem_usage : null;
}

Remote.prototype.disk = function() {
  return this.connected ? this.disk_usage : null;
}

Remote.prototype.processes = function() {
  return this.connected ? this.process_list : null;
}

module.exports = Remote;
