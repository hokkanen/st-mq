-- Run from any directory with lua, lua5.3, lua5.4, or texlua.
-- These tests execute the real subdriver with small SmartThings API stubs.
-- They do not replace a hub integration test or the detector's physical self-test.
local filename = arg[0]
local base = filename:match("^(.*)/tests/[^/]+$") or "."
package.path = base .. "/driver/src/?.lua;" .. base .. "/driver/src/?/init.lua;" .. package.path

local count = 0
local function check(value, description)
  assert(value, description)
  count = count + 1
end
local function capability(id, attribute, enum)
  local attr = setmetatable({}, {__call = function(_, value, metadata)
    return {capability = id, attribute = attribute, value = value, metadata = metadata}
  end})
  if enum then attr[enum] = function() return attr(enum) end end
  return {ID = id, [attribute] = attr}
end
local capabilities = {
  temperatureMeasurement = capability("temperatureMeasurement", "temperature"),
  smokeDetector = capability("smokeDetector", "smoke", "clear"),
  tamperAlert = capability("tamperAlert", "tamper", "clear"),
  temperatureAlarm = capability("temperatureAlarm", "temperatureAlarm", "cleared"),
}
local cc = {SENSOR_MULTILEVEL = 0x31, WAKE_UP = 0x84}
local function command_class(name, constants)
  return setmetatable(constants, {
    __call = function(self) return self end,
    __index = function(_, command)
      return function(_, args) return {class = name, command = command, args = args} end
    end,
  })
end
local sensor = command_class("SensorMultilevel", {
  REPORT = 5, sensor_type = {TEMPERATURE = 1},
  scale = {temperature = {CELSIUS = 0, FAHRENHEIT = 1}},
})
local wakeup = command_class("WakeUp", {NOTIFICATION = 7})
package.preload["st.capabilities"] = function() return capabilities end
package.preload["st.zwave.CommandClass"] = function() return cc end
package.preload["st.zwave.CommandClass.SensorMultilevel"] = function() return sensor end
package.preload["st.zwave.CommandClass.WakeUp"] = function() return wakeup end
package.preload["st.zwave.CommandClass.Battery"] = function() return command_class("Battery", {}) end

local driver = require("fibaro-smoke-sensor")
local events, sends, fields = {}, {}, {}
local device = {
  emit_event_for_endpoint = function(_, endpoint, event)
    events[#events + 1] = {endpoint = endpoint, event = event}
  end,
  emit_event = function(_, event) events[#events + 1] = {event = event} end,
  send = function(_, command) sends[#sends + 1] = command end,
  get_field = function(_, key) return fields[key] end,
  set_field = function(_, key, value) fields[key] = value end,
  id_match = function(_, manufacturer, product_type, product)
    return manufacturer == 0x010F and product_type == 0x0C02 and product == 0x1002
  end,
}
local handler = driver.zwave_handlers[cc.SENSOR_MULTILEVEL][sensor.REPORT]
check(type(handler) == "function", "explicit temperature REPORT dispatch")
local matches, selected = driver.can_handle({}, {}, device)
check(matches and selected == driver, "stock Fibaro fingerprint selects this subdriver")

local function report(value, scale, endpoint, sensor_type)
  handler({}, device, {src_channel = endpoint, args = {
    sensor_type = sensor_type or sensor.sensor_type.TEMPERATURE,
    sensor_value = value, scale = scale,
  }})
end
report(21.5, 0, 0)
report(21.5, 0, 0)
report(22, 0, 0)
check(#events == 3, "equal consecutive genuine reports are all emitted")
for _, item in ipairs(events) do
  check(item.event.metadata.state_change == true, "boolean state_change metadata")
  check(item.event.value.unit == "C" and item.endpoint == 0, "Celsius and root endpoint preserved")
end
check(events[1].event.value.value == 21.5 and events[3].event.value.value == 22,
  "reported values preserved")
report(70, 1, 3)
check(events[4].endpoint == 3 and events[4].event.value.unit == "F"
  and events[4].event.value.value == 70, "Fahrenheit and non-root endpoint preserved")
report(-10, 0, 1)
report(0, 0, 1)
check(events[5].event.value.value == -10 and events[6].event.value.value == 0,
  "negative and zero temperatures preserved")
local before = #events
report(1, 0, 0, 3)
report("21.5", 0, 0)
report(nil, 0, 0)
report(0/0, 0, 0)
report(math.huge, 0, 0)
report(-math.huge, 0, 0)
report(21, 2, 0)
report(21, nil, 0)
check(#events == before, "non-temperature, invalid values and unsupported scales rejected")
check(#sends == 0, "temperature reports create no polls or configuration writes")

events, sends = {}, {}
driver.lifecycle_handlers.added({environment_info = {hub_zwave_id = 1}}, device)
check(#events == 3 and events[1].event.capability == "smokeDetector"
  and events[1].event.value == "clear" and events[2].event.capability == "tamperAlert"
  and events[3].event.capability == "temperatureAlarm", "stock initial alarm states retained")
check(#sends == 3 and sends[1].class == "WakeUp" and sends[1].command == "IntervalSet"
  and sends[1].args.seconds == 21600, "stock six-hour wake-up configuration retained")
check(sends[2].class == "Battery" and sends[2].command == "Get"
  and sends[3].class == "SensorMultilevel" and sends[3].command == "Get",
  "stock initial battery and temperature requests retained")

events, sends = {}, {}
local wakeup_handler = driver.zwave_handlers[cc.WAKE_UP][wakeup.NOTIFICATION]
wakeup_handler({}, device, {})
check(#sends == 3 and sends[1].class == "WakeUp" and sends[1].command == "IntervalGetV1"
  and sends[2].class == "Battery" and sends[3].class == "SensorMultilevel",
  "first wake-up retains interval, battery and temperature requests")
check(#events == 1 and events[1].event.capability == "smokeDetector"
  and events[1].event.value == "clear", "stock wake-up smoke event retained")
events, sends = {}, {}
wakeup_handler({}, device, {})
check(#sends == 2 and sends[1].class == "Battery" and sends[2].class == "SensorMultilevel",
  "subsequent wake-up does not repeat interval discovery")
check(driver.health_check == false, "stock health-check policy retained")
print(string.format("Passed %d Lua behavior assertions", count))
