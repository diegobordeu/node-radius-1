var fs = require('fs');
var crypto = require('crypto');

var Radius = {};

var attributes_map = {}, vendor_name_to_id = {};
var dictionary_locations = [__dirname + '/../dictionaries'];

const NO_VENDOR = -1;

const ATTR_ID = 0;
const ATTR_NAME = 1;
const ATTR_TYPE = 2;
const ATTR_ENUM = 3;
const ATTR_REVERSE_ENUM = 4;
const ATTR_MODIFIERS = 5;

Radius.add_dictionary = function(path) {
  dictionary_locations.push(path);
};

Radius.load_dictionaries = function() {
  for (var i = 0; i < dictionary_locations.length; i++) {
    var path = dictionary_locations[i];
    if (!fs.existsSync(path))
      throw new Error("Invalid dictionary location: " + path);

    if (fs.statSync(path).isDirectory()) {
      var files = fs.readdirSync(path);
      for (var j = 0; j < files.length; j++) {
        this.load_dictionary(path + '/' + files[j]);
      }
    } else {
     this.load_dictionary(path);
    }
  }
};

Radius.load_dictionary = function(path) {
  var lines = fs.readFileSync(path, 'ascii').split("\n");

  var vendor = NO_VENDOR;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    line = line.replace(/#.*/, '').replace(/\s+/g, ' ');

    var match = line.match(/^\s*VENDOR\s+(\S+)\s+(\d+)/);
    if (match) {
      vendor_name_to_id[match[1]] = match[2];
      continue;
    }

    if ((match = line.match(/^\s*BEGIN-VENDOR\s+(\S+)/))) {
      vendor = vendor_name_to_id[match[1]];
      continue;
    }

    if (line.match(/^\s*END-VENDOR/)) {
      vendor = NO_VENDOR;
      continue;
    }

    match = line.match(/^\s*(?:VENDOR)?ATTR(?:IBUTE)?\s+(\d+)?\s*(\S+)\s+(\d+)\s+(\S+)\s*(.+)?/);
    if (match) {
      var attr_vendor = vendor;
      if (match[1] !== undefined)
        attr_vendor = match[1];

      if (!attributes_map[attr_vendor])
        attributes_map[attr_vendor] = {};

      var modifiers = {};
      if (match[5] !== undefined) {
        match[5].replace(/\s*/g, '').split(',').forEach(function(m) {
          modifiers[m] = true;
        });
      }

      attributes_map[attr_vendor][match[3]] = [match[3], match[2], match[4], {}, {}, modifiers];
      attributes_map[attr_vendor][match[2]] = attributes_map[attr_vendor][match[3]];

      continue;
    }

    match = line.match(/^\s*(?:VENDOR)?VALUE\s+(\d+)?\s*(\S+)\s+(\S+)\s+(\d+)/);
    if (match) {
      var attr_vendor = vendor;
      if (match[1] !== undefined)
        attr_vendor = match[1];

      attributes_map[attr_vendor][match[2]][ATTR_ENUM][match[4]] = match[3];
      attributes_map[attr_vendor][match[2]][ATTR_REVERSE_ENUM][match[3]] = match[4];

      continue;
    }
  }
};

Radius.unload_dictionaries = function() {
  attributes_map = {};
  vendor_name_to_id = {};
};

Radius.attr_name_to_id = function(attr_name, vendor_id) {
  return this._attr_to(attr_name, vendor_id, ATTR_ID);
};

Radius.attr_id_to_name = function(attr_name, vendor_id) {
  return this._attr_to(attr_name, vendor_id, ATTR_NAME);
};

Radius._attr_to = function(attr, vendor_id, target) {
  if (vendor_id === undefined)
    vendor_id = NO_VENDOR;

  if (!attributes_map[vendor_id])
    return;

  var attr_info = attributes_map[vendor_id||NO_VENDOR][attr];
  if (!attr_info)
    return;

  return attr_info[target];
};

var code_map = {
  1: 'Access-Request',
  2: 'Access-Accept',
  3: 'Access-Reject',
  4: 'Accounting-Request',
  5: 'Accounting-Response',
  11: 'Access-Challenge',
  12: 'Status-Server',
  13: 'Status-Client'
};

var reverse_code_map = {};
for (var code in code_map)
  reverse_code_map[code_map[code]] = code;

Radius.decode = function(packet, secret) {
  if (!packet || packet.length < 4)
    throw new Error("Invalid packet");

  var ret = {};

  ret.code = code_map[packet.readUInt8(0)];

  if (!ret.code)
    throw new Error("Invalid packet code");

  ret.identifier = packet.readUInt8(1);
  ret.length = packet.readUInt16BE(2);

  if (packet.length < ret.length)
    throw new Error("Incomplete packet");

  this.authenticator = ret.authenticator = packet.slice(4, 20);
  this.secret = secret;

  var attrs = packet.slice(20, ret.length);
  ret.attributes = {};
  ret.raw_attributes = [];

  this.decode_attributes(attrs, ret.attributes, NO_VENDOR, ret.raw_attributes);

  return ret;
};

Radius.decode_attributes = function(data, attr_hash, vendor, raw_attrs) {
  var type, length, value, tag;
  while (data.length > 0) {
    type = data.readUInt8(0);
    length = data.readUInt8(1);
    value = data.slice(2, length);

    if (raw_attrs)
      raw_attrs.push([type, value]);

    data = data.slice(length);
    var attr_info = attributes_map[vendor] && attributes_map[vendor][type];
    if (!attr_info)
      continue;

    if (attr_info[ATTR_MODIFIERS]["has_tag"]) {
      var first_byte = value.readUInt8(0);
      if (first_byte <= 0x1F) {
        tag = first_byte;
        value = value.slice(1);
      } else {
        tag = undefined;
      }
    }

    if (attr_info[ATTR_MODIFIERS]["encrypt=1"]) {
      value = this.decrypt_field(value);
    } else {

      switch (attr_info[ATTR_TYPE]) {
      case "string":
      case "text":
        // assumes utf8 encoding for strings
        value = value.toString("utf8");
        break;
      case "ipaddr":
        var octets = [];
        for (var i = 0; i < value.length; i++)
          octets.push(value[i]);
        value = octets.join(".");
        break;
      case "time":
      case "integer":
        if (attr_info[ATTR_MODIFIERS]['has_tag']) {
          var buf = new Buffer([0, 0, 0, 0]);
          value.copy(buf, 1);
          value = buf;
        }

        value = value.readUInt32BE(0);
        value = attr_info[ATTR_ENUM][value] || value;
        break;
      }

      if (attr_info[ATTR_NAME] == 'Vendor-Specific') {
        if (value[0] !== 0x00)
          throw new Error("Invalid vendor id");

        var vendor_attrs = attr_hash['Vendor-Specific'];
        if (!vendor_attrs)
          vendor_attrs = attr_hash['Vendor-Specific'] = {};

        this.decode_attributes(value.slice(4), vendor_attrs, value.readUInt32BE(0));
        value = vendor_attrs;
      }
    }

    if (tag !== undefined)
      value = [tag, value];

    attr_hash[attr_info[ATTR_NAME]] = value;
  }
};

Radius.decrypt_field = function(field) {
  if (field.length < 16)
    throw new Error("Invalid password: too short");

  if (field.length > 128)
    throw new Error("Invalid password: too long");

  if (field.length % 16 != 0)
    throw new Error("Invalid password: not padded");

  return this._crypt_field(field, true).toString("utf8");
};

Radius.encrypt_field = function(field) {
  var buf = new Buffer(field.length + 15 - ((15 + field.length) % 16));
  buf.write(field, 0, field.length);

  // null-out the padding
  for (var i = field.length; i < buf.length; i++)
    buf[i] = 0x00;

  return this._crypt_field(buf, false);
};

Radius._crypt_field = function(field, is_decrypt) {
  var ret = new Buffer(0);
  var second_part_to_be_hashed = this.authenticator;

  if (this.secret === undefined)
    throw new Error("Must provide RADIUS shared secret");

  for (var i = 0; i < field.length; i = i + 16) {
    var hasher = crypto.createHash("md5");
    hasher.update(this.secret);
    hasher.update(second_part_to_be_hashed);
    var hash = new Buffer(hasher.digest("binary"), "binary");

    var xor_result = new Buffer(16);
    for (var j = 0; j < 16; j++) {
      xor_result[j] = field[i + j] ^ hash[j];
      if (is_decrypt && xor_result[j] == 0x00) {
        xor_result = xor_result.slice(0, j);
        break;
      }
    }
    ret = Buffer.concat([ret, xor_result]);
    second_part_to_be_hashed = is_decrypt ? field.slice(i, i + 16) : xor_result;
  }

  return ret;
};

Radius.encode_response = function(packet, args) {
  if (!args.attributes)
    args.attributes = [];

  var proxy_state_id = attributes_map[NO_VENDOR]['Proxy-State'][ATTR_ID];
  for (var i = 0; i < packet.raw_attributes.length; i++) {
    var attr = packet.raw_attributes[i];
    if (attr[0] == proxy_state_id)
      args.attributes.push(attr);
  }

  var response = this.encode({
    code: args.code,
    identifier: packet.identifier,
    authenticator: packet.authenticator,
    attributes: args.attributes,
    secret: args.secret
  });

  var hasher = crypto.createHash("md5");
  hasher.update(response);
  hasher.update(args.secret);

  response.write(hasher.digest("binary"), 4, 16, "binary");
  return response;
};

Radius.encode = function(args) {
  if (!args || args.code === undefined)
    throw new Error("encode: must specify code");

  if (args.secret === undefined)
    throw new Error("encode: must provide RADIUS shared secret");

  var packet = new Buffer(4096);
  var offset = 0;

  var code = reverse_code_map[args.code];
  if (code === undefined)
    throw new Error("Invalid packet code");

  packet.writeUInt8(+code, offset);
  offset += 1;

  packet.writeUInt8(args.identifier || Math.floor(Math.random() * 256), offset);
  offset += 1;

  // save room for length
  offset += 2;

  var authenticator;
  if (args.code == "Accounting-Request") {
    authenticator = new Buffer(16);
    authenticator.fill(0x00);
  } else {
    authenticator = args.authenticator || crypto.randomBytes(16);
  }
  authenticator.copy(packet, offset);
  offset += 16;

  this.secret = args.secret;
  this.authenticator = authenticator;
  offset += this.encode_attributes(packet.slice(offset), args.attributes, NO_VENDOR);

  // now write the length in
  packet.writeUInt16BE(offset, 2);

  packet = packet.slice(0, offset);

  if (args.code == "Accounting-Request") {
    var hasher = crypto.createHash("md5");
    hasher.update(packet);
    hasher.update(args.secret);
    packet.write(hasher.digest("binary"), 4, 16, "binary");
  }

  return packet;
};

Radius.encode_attributes = function(packet, attributes, vendor) {
  if (!attributes)
    return 0;

  var offset = 0;
  for (var i = 0; i < attributes.length; i++) {
    var attr = attributes[i];
    var attr_info = attributes_map[vendor] && attributes_map[vendor][attr[0]];
    if (!attr_info && !(attr[1] instanceof Buffer)) {
      throw new Error("Invalid attributes in encode: must give Buffer for " +
        "unknown attribute '" + attr[0] + "'");
    }

    // write the attribute id
    packet.writeUInt8(attr_info ? +attr_info[ATTR_ID] : +attr[0], offset);
    offset += 1;

    var out_value, in_value = attr[1];
    if (in_value instanceof Buffer) {
      out_value = in_value;
    } else {
      var has_tag = attr_info[ATTR_MODIFIERS]["has_tag"] && attr.length == 3;

      if (has_tag) {
        in_value = attr[2];
      }

      if (attr_info[ATTR_MODIFIERS]["encrypt=1"]) {
        out_value = this.encrypt_field(in_value);
      } else {
        switch (attr_info[ATTR_TYPE]) {
        case "string":
        case "text":
          out_value = new Buffer(in_value + '', 'utf8');
          break;
        case "ipaddr":
          out_value = new Buffer(in_value.split('.'));
          break;
        case "time":
        case "integer":
          out_value = new Buffer(4);

          in_value = attr_info[ATTR_REVERSE_ENUM][in_value] || in_value;
          if (isNaN(in_value))
            throw new Error("Invalid attribute value: " + in_value);

          out_value.writeUInt32BE(+in_value, 0);

          if (has_tag)
            out_value = out_value.slice(1);

          break;
        case "octets":
          if (attr_info[ATTR_NAME] != "Vendor-Specific")
            throw new Error("Must provide Buffer for attribute '" + attr_info[ATTR_NAME] + "'");
          break;
        }

        // handle VSAs specially
        if (attr_info[ATTR_NAME] == "Vendor-Specific") {
          var vendor_id = isNaN(attr[1]) ? vendor_name_to_id[attr[1]] : attr[1];
          if (vendor_id === undefined)
            throw new Error("Unknown vendor '" + attr[1] + "'");

          var length = this.encode_attributes(packet.slice(offset + 5), attr[2], vendor_id);

          if (length > 255)
            throw new Error("Too many vendor specific attributes (try splitting them up)");

          // write in the length
          packet.writeUInt8(2 + 4 + length, offset);
          // write in the vendor id
          packet.writeUInt32BE(+vendor_id, offset + 1);

          offset += 5 + length;
          continue;
        }
      }
    }

    // write in the attribute length
    packet.writeUInt8(2 + out_value.length + (has_tag ? 1 : 0), offset);
    offset += 1;

    if (has_tag) {
      packet.writeUInt8(attr[1], offset);
      offset += 1;
    }

    // copy in the attribute value
    out_value.copy(packet, offset);
    offset += out_value.length;
  }

  return offset;
};

module.exports = Radius;