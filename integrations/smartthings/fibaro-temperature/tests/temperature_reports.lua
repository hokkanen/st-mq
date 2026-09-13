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
    __call = function(_, options)
      return setmetatable({version = options.version}, {
        __index = function(instance, command)
          if constants[command] ~= nil then return constants[command] end
          return function(_, args)
            return {class = name, command = command, args = args, version = instance.version}
          end
        end,
      })
    end,
  })
end
local sensor = command_class("SensorMultilevel", {
  REPORT = 5, sensor_type = {TEMPERATURE = 1},
  scale = {temperature = {CELSIUS = 0, FAHRENHEIT = 1}},
})
local wakeup = command_class("WakeUp", {NOTIFICATION = 7, INTERVAL_REPORT = 6, INTERVAL_CAPABILITIES_REPORT = 10})
package.preload["st.capabilities"] = function() return capabilities end
package.preload["st.zwave.CommandClass"] = function() return cc end
package.preload["st.zwave.CommandClass.SensorMultilevel"] = function() return sensor end
package.preload["st.zwave.CommandClass.WakeUp"] = function() return wakeup end
package.preload["st.zwave.CommandClass.Battery"] = function() return command_class("Battery", {}) end

local logs = {}
package.preload["log"] = function()
  return {info = function(message) logs[#logs + 1] = message end, warn = function() end}
end

local driver = require("fibaro-smoke-sensor")
local events, sends, fields, persisted = {}, {}, {}, {}
local device = {
  preferences = {},
  emit_event_for_endpoint = function(_, endpoint, event)
    events[#events + 1] = {endpoint = endpoint, event = event}
  end,
  emit_event = function(_, event) events[#events + 1] = {event = event} end,
  send = function(_, command) sends[#sends + 1] = command end,
  get_field = function(_, key) return fields[key] end,
  set_field = function(_, key, value, options)
    fields[key] = value
    persisted[key] = options and options.persist
  end,
  id_match = function(_, manufacturer, product_type, product)
    return manufacturer == 0x010F and product_type == 0x0C02
      and (product == 0x1002 or type(product) == "table" and product[1] == 0x1002)
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

local controller = {environment_info = {hub_zwave_id = 1}}
local wakeup_handler = driver.zwave_handlers[cc.WAKE_UP][wakeup.NOTIFICATION]
local interval_handler = driver.zwave_handlers[cc.WAKE_UP][wakeup.INTERVAL_REPORT]
local limits_handler = driver.zwave_handlers[cc.WAKE_UP][wakeup.INTERVAL_CAPABILITIES_REPORT]
local function command_count(class, command)
  local found = 0
  for _, item in ipairs(sends) do
    if item.class == class and item.command == command then found = found + 1 end
  end
  return found
end
local function wake()
  events, sends = {}, {}
  wakeup_handler(controller, device, {})
end
local function confirm(seconds, node_id)
  interval_handler(controller, device, {args = {seconds = seconds, node_id = node_id or 1}})
end

events, sends = {}, {}
driver.lifecycle_handlers.added(controller, device)
check(#events == 3 and events[1].event.capability == "smokeDetector"
  and events[1].event.value == "clear" and events[2].event.capability == "tamperAlert"
  and events[3].event.capability == "temperatureAlarm", "stock initial alarm states retained")
check(#sends == 4 and sends[1].class == "WakeUp" and sends[1].command == "IntervalSet"
  and sends[1].args.seconds == 4200 and sends[1].args.node_id == 1,
  "new device requests default 70-minute interval and correct hub")
check(sends[2].command == "IntervalGetV1" and sends[3].class == "Battery"
  and sends[4].class == "SensorMultilevel", "added reads interval back and retains battery/temperature requests")

fields = {} -- Existing sleeping detector: no added event or previous observation.
wake()
check(sends[1].command == "IntervalSet" and sends[1].args.seconds == 4200,
  "first natural wake applies default even without an explicit preference value")
check(sends[2].command == "IntervalGetV1" and sends[3].class == "Battery"
  and sends[4].class == "SensorMultilevel", "wake reads back interval and keeps genuine battery/temperature queries")
check(#events == 1 and events[1].event.capability == "smokeDetector"
  and events[1].event.value == "clear", "stock wake-up smoke event retained")
check(sends[5].class == "WakeUp" and sends[5].command == "IntervalCapabilitiesGet"
  and sends[5].version == 2, "first wake queries supported limits")
check(fields.__stmq_wakeup_capabilities_queried == true, "limits query guarded for runtime")
check(fields.stmq_wakeup_observed == nil, "Set transmission does not pretend to be readback")
wake()
check(command_count("WakeUp", "IntervalSet") == 1
  and command_count("WakeUp", "IntervalCapabilitiesGet") == 0,
  "missing response retries at next wake without repeating successful query submission")
confirm(21600)
wake()
check(sends[1].command == "IntervalSet" and sends[1].args.seconds == 4200,
  "old interval readback retries desired default at next wake")
confirm(4200, 2)
wake()
check(command_count("WakeUp", "IntervalSet") == 1,
  "correct interval addressed to wrong controller still needs correction")
confirm(4200)
wake()
check(command_count("WakeUp", "IntervalSet") == 0
  and command_count("WakeUp", "IntervalGetV1") == 1,
  "confirmed interval avoids repeated writes but reads back drift on each wake")
check(command_count("SensorMultilevel", "Get") == 1,
  "confirmed interval still requests real temperature")
check(persisted.stmq_wakeup_observed == true, "observed interval is persisted across runtime restart")

local actual = fields.stmq_wakeup_observed
confirm(0/0)
confirm(math.huge)
confirm(-1)
confirm("4200")
confirm(4200, 0)
check(fields.stmq_wakeup_observed == actual, "invalid interval reports do not overwrite confirmed state")

device.preferences.wakeUpIntervalSeconds = "7200"
check(#sends == 3, "changing a sleeping preference causes no immediate radio writes")
wake()
check(sends[1].command == "IntervalSet" and sends[1].args.seconds == 7200,
  "user-selected two hours supersedes default at next natural wake")
confirm(7200)
fields.__wakeup_interval_get_sent = nil
fields.__stmq_wakeup_capabilities_queried = nil
wake()
check(command_count("WakeUp", "IntervalSet") == 0,
  "runtime restart preserves observed selected non-default interval")
for _, seconds in ipairs({10800, 21600, 43200}) do
  device.preferences.wakeUpIntervalSeconds = tostring(seconds)
  wake()
  check(sends[1].command == "IntervalSet" and sends[1].args.seconds == seconds,
    "supported selector choice honored: " .. seconds)
end
for _, selection in ipairs({"3600", "900", "0", "invalid"}) do
  device.preferences.wakeUpIntervalSeconds = selection
  wake()
  check(command_count("WakeUp", "IntervalSet") == 0,
    "invalid/below-minimum preference never writes: " .. selection)
end

device.preferences.wakeUpIntervalSeconds = "4200"
limits_handler(controller, device, {args = {
  minimum_wake_up_interval_seconds = 21600, maximum_wake_up_interval_seconds = 86400,
}})
wake()
check(command_count("WakeUp", "IntervalSet") == 0,
  "detector-reported higher minimum prevents repeated unsupported writes")
check(persisted.stmq_wakeup_limits == true, "detector limits retained across runtime restart")
limits_handler(controller, device, {args = {
  minimum_wake_up_interval_seconds = 4200, maximum_wake_up_interval_seconds = 86400,
}})
confirm(21600)
wake()
check(sends[1].command == "IntervalSet" and sends[1].args.seconds == 4200,
  "70-minute compatible limits allow retry of an unconfirmed interval")
check(driver.health_check == false, "stock health-check policy retained")

-- Execute the real parent driver lifecycle and configuration sender too.
local template, update_preferences
package.preload["st.zwave.driver"] = function()
  return function(_, definition)
    template = definition
    return {run = function() end}
  end
end
package.preload["st.zwave.defaults"] = function()
  return {register_for_default_handlers = function(definition, supported)
    check(definition.supported_capabilities == supported, "default capability handler registration retained")
  end}
end
package.preload["st.zwave.CommandClass.Configuration"] = function() return command_class("Configuration", {}) end
package.preload["sub_drivers"] = function() return {} end
device.set_update_preferences_fn = function(_, callback) update_preferences = callback end
device.is_cc_supported = function(_, command_class) return command_class == cc.WAKE_UP end
dofile(base .. "/driver/src/init.lua")
events, sends = {}, {}
template.lifecycle_handlers.init(controller, device)
check(type(update_preferences) == "function" and #sends == 0,
  "initialization registers natural-wake preference callback without radio writes")
check(logs[#logs] == "Preference application initialized: mapped=9 local=0 legacy=0 attempted=false",
  "initialization diagnostics contain only counts and an attempted-state boolean")
template.lifecycle_handlers.infoChanged(controller, device, {}, {old_st_store = {preferences = {}}})
check(#sends == 0, "sleeping infoChanged defers settings until wake")
local prefix = "certifiedpreferences."
local settings = {
  smokeSensorSensitivity = {1, 1, 1}, zwaveNotificationStatus = {2, 1, 0},
  indicatorNotification = {3, nil, 0}, soundNotificationStatus = {4, 1, 0},
  tempReportInterval = {20, 2, 90}, tempReportHysteresis = {21, 2, 1},
  temperatureThreshold = {30, 2, 10}, overheatInterval = {31, 2, 180}, outOfRange = {32, 2, 360},
}
device.preferences = {wakeUpIntervalSeconds = "4200", unknownPreference = 3}
for name, expected in pairs(settings) do device.preferences[prefix .. name] = expected[3] end
update_preferences(controller, device)
check(#sends == 9, "initial configure sends nine mapped preferences and skips wake selector/unknown fields")
local sent = {}
for _, item in ipairs(sends) do sent[item.args.parameter_number] = item.args end
for name, expected in pairs(settings) do
  local item = sent[expected[1]]
  check(item and item.size == expected[2] and item.configuration_value == expected[3],
    "legacy mapping, size, and raw default retained: " .. name)
end
sends = {}
local old = {}
for name, value in pairs(device.preferences) do old[name] = value end
update_preferences(controller, device, {old_st_store = {preferences = old}})
check(#sends == 0, "unchanged saved configuration is not resent")
device.preferences.wakeUpIntervalSeconds = "7200"
update_preferences(controller, device, {old_st_store = {preferences = old}})
check(#sends == 0, "wake-only change is never interpreted as a Configuration parameter")
device.preferences[prefix .. "tempReportInterval"] = "30"
update_preferences(controller, device, {old_st_store = {preferences = old}})
check(#sends == 1 and sends[1].args.parameter_number == 20
  and sends[1].args.configuration_value == 30, "ordinary preference edits retain existing numeric conversion")
-- During profile migration an old namespaced value is usable only if its new
-- local setting is absent. An explicit local choice (including zero) wins.
sends = {}
device.preferences = {
  wakeUpIntervalSeconds = "4200", tempReportInterval = "90",
  [prefix .. "tempReportInterval"] = "30", indicatorNotification = 0,
  [prefix .. "indicatorNotification"] = 7,
}
update_preferences(controller, device)
check(#sends == 2, "local and legacy IDs never cause duplicate Configuration writes")
sent = {}
for _, item in ipairs(sends) do sent[item.args.parameter_number] = item.args end
check(sent[20].configuration_value == 90 and sent[3].configuration_value == 0,
  "local visible selections take priority over retained legacy values, including zero")
sends = {}
update_preferences(controller, device, {old_st_store = {preferences = {
  [prefix .. "tempReportInterval"] = "90", [prefix .. "indicatorNotification"] = 0,
}}})
check(#sends == 0, "same-value ID migration does not resend unchanged parameters")
-- Newly materialized profile defaults may be identical to the SDK's init
-- snapshot. They still need one real-wake write attempt, including after restart.
local attempt_field = "stmq_local_preferences_attempted_revision"
fields[attempt_field] = nil
fields.__stmq_preference_pending_logged = nil
device.preferences = {wakeUpIntervalSeconds = "4200"}
for name, expected in pairs(settings) do device.preferences[name] = expected[3] end
device.preferences.tempReportInterval = "30" -- User selection before first wake.
old = {}
for name, value in pairs(device.preferences) do old[name] = value end
sends = {}
template.lifecycle_handlers.doConfigure(controller, device)
check(#sends == 9 and fields[attempt_field] == nil,
  "doConfigure can send setup commands but never consumes the real-wake attempt")
template.lifecycle_handlers.init(controller, device) -- Restart before first wake.
sends = {}
update_preferences(controller, device, {old_st_store = {preferences = old}})
check(#sends == 9 and fields[attempt_field] == 1 and persisted[attempt_field] == true,
  "first real wake attempts all local selections despite unchanged SDK snapshot and restart")
check(logs[#logs] == "Preference application first pending wake: mapped=9 local=9 legacy=0 attempted=false",
  "first pending wake diagnostics expose no preference values or device identity")
sent = {}
for _, item in ipairs(sends) do sent[item.args.parameter_number] = item.args end
check(sent[20].configuration_value == 30,
  "one-time application honors user edits before first wake rather than hardcoded defaults")
template.lifecycle_handlers.init(controller, device) -- Restart after attempt.
sends = {}
update_preferences(controller, device, {old_st_store = {preferences = old}})
check(#sends == 0, "persisted attempt survives restart without repeating nine unchanged writes")
device.preferences.tempReportInterval = "90"
update_preferences(controller, device, {old_st_store = {preferences = old}})
check(#sends == 1 and sends[1].args.parameter_number == 20,
  "ordinary local selection changes still apply after one-time initialization")

fields[attempt_field] = nil
device.preferences.tempReportInterval = nil
device.preferences[prefix .. "tempReportInterval"] = "90"
old = {}
for name, value in pairs(device.preferences) do old[name] = value end
sends = {}
update_preferences(controller, device, {old_st_store = {preferences = old}})
check(#sends == 0 and fields[attempt_field] == nil,
  "partial local profile waits instead of forcing legacy fallback settings or marking complete")
device.preferences.tempReportInterval = "90"
old.tempReportInterval = "90" -- Simulate a refreshed SDK init snapshot.
update_preferences(controller, device, {old_st_store = {preferences = old}})
check(#sends == 9 and fields[attempt_field] == 1,
  "complete local profile triggers first awake attempt even after delayed materialization")

fields[attempt_field] = nil
local normal_send = device.send
local calls = 0
device.send = function(_, command)
  calls = calls + 1
  if calls == 4 then error("simulated send failure") end
  normal_send(device, command)
end
local ok = pcall(update_preferences, controller, device, {old_st_store = {preferences = old}})
check(not ok and fields[attempt_field] == nil,
  "partial sender failure never persists a completed application attempt")
device.send = normal_send
sends = {}
update_preferences(controller, device, {old_st_store = {preferences = old}})
check(#sends == 9 and fields[attempt_field] == 1,
  "next wake retries full selection after interrupted sending")
print(string.format("Passed %d Lua behavior assertions", count))
