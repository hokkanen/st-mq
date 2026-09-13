-- Copyright 2022 SmartThings, Inc.
-- Licensed under the Apache License, Version 2.0


local capabilities = require "st.capabilities"
--- @type st.zwave.CommandClass
local cc = require "st.zwave.CommandClass"
--- @type st.zwave.CommandClass.Battery
local Battery = (require "st.zwave.CommandClass.Battery")({ version=1 })
--- @type st.zwave.CommandClass.SensorMultilevel
local SensorMultilevel = (require "st.zwave.CommandClass.SensorMultilevel")({ version=5 })
--- @type st.zwave.CommandClass.WakeUp
local WakeUp = (require "st.zwave.CommandClass.WakeUp")({version=1})
local WakeUpV2 = (require "st.zwave.CommandClass.WakeUp")({version=2})

local DEFAULT_WAKEUP_INTERVAL = 4200 -- 70 minutes, in seconds
local WAKEUP_CHOICES = {[4200] = true, [7200] = true, [10800] = true, [21600] = true, [43200] = true}
local log = require "log"

local function selected_wakeup_interval(device)
  local selection = device.preferences.wakeUpIntervalSeconds
  if selection == nil then return DEFAULT_WAKEUP_INTERVAL end
  local seconds = tonumber(selection)
  if not WAKEUP_CHOICES[seconds] then
    log.warn("Ignoring invalid wake-up interval preference")
    return nil
  end
  return seconds
end

-- Called only while a detector is awake (added or WakeUp.Notification).
-- A saved choice remains authoritative across driver/hub restarts. Successful
-- Set transmission is not confirmation: only an IntervalReport is readback.
local function configure_wakeup(self, device)
  local seconds = selected_wakeup_interval(device)
  local hub_node = self.environment_info.hub_zwave_id
  local limits = device:get_field("stmq_wakeup_limits")
  if seconds and limits and (seconds < limits.minimum or seconds > limits.maximum) then
    log.warn("Selected wake-up interval is outside this detector's reported limits")
    seconds = nil
  end
  local observed = device:get_field("stmq_wakeup_observed")
  if seconds and (not observed or observed.seconds ~= seconds or observed.node_id ~= hub_node) then
    device:send(WakeUp:IntervalSet({node_id = hub_node, seconds = seconds}))
  end
  -- Read back on every wake: retry a missing/mismatched Set next time, while
  -- avoiding repeated writes once the interval and controller are confirmed.
  device:send(WakeUp:IntervalGetV1({}))
  device:set_field("__wakeup_interval_get_sent", true)
end

local function wakeup_interval_report_handler(self, device, cmd)
  local seconds, node_id = cmd.args.seconds, cmd.args.node_id
  if type(seconds) ~= "number" or seconds < 0 or seconds > 0xFFFFFF or seconds ~= math.floor(seconds) or
    type(node_id) ~= "number" or node_id < 1 or node_id > 232 or node_id ~= math.floor(node_id) then return end
  device:set_field("stmq_wakeup_observed", {seconds = seconds, node_id = node_id}, {persist = true})
  if seconds == selected_wakeup_interval(device) and node_id == self.environment_info.hub_zwave_id then
    log.info("Selected wake-up interval confirmed by detector")
  else
    log.warn("Wake-up interval differs from selection; will retry on next wake")
  end
end

local function wakeup_capabilities_report_handler(self, device, cmd)
  local minimum = cmd.args.minimum_wake_up_interval_seconds
  local maximum = cmd.args.maximum_wake_up_interval_seconds
  if type(minimum) == "number" and type(maximum) == "number" and
    minimum >= 0 and minimum <= maximum and maximum < math.huge then
    device:set_field("stmq_wakeup_limits", {minimum = minimum, maximum = maximum}, {persist = true})
  end
end


--- Determine whether the passed device is fibaro smoke sensro
---
--- @param driver st.zwave.Driver
--- @param device st.zwave.Device
--- @return boolean true if the device is fibaro smoke sensor

local function device_added(self, device)
  configure_wakeup(self, device)
  device:emit_event(capabilities.smokeDetector.smoke.clear())
  device:emit_event(capabilities.tamperAlert.tamper.clear())
  device:emit_event(capabilities.temperatureAlarm.temperatureAlarm.cleared())
  device:send(Battery:Get({}))
  device:send(SensorMultilevel:Get({sensor_type = SensorMultilevel.sensor_type.TEMPERATURE}))
end

local function wakeup_notification_handler(self, device, cmd)
  configure_wakeup(self, device)
  device:emit_event(capabilities.smokeDetector.smoke.clear())
  device:send(Battery:Get({}))
  device:send(SensorMultilevel:Get({sensor_type = SensorMultilevel.sensor_type.TEMPERATURE}))
  -- Read the detector's actual supported limits once per driver runtime.
  -- The decoded response is available in private logcat and limits later writes.
  if not device:get_field("__stmq_wakeup_capabilities_queried") then
    device:send(WakeUpV2:IntervalCapabilitiesGet({}))
    device:set_field("__stmq_wakeup_capabilities_queried", true)
  end
end

-- Forward every genuine Fibaro temperature report, including equal values.
local function temperature_report_handler(self, device, cmd)
  if cmd.args.sensor_type ~= SensorMultilevel.sensor_type.TEMPERATURE then return end
  local value = cmd.args.sensor_value
  if type(value) ~= "number" or value ~= value or math.abs(value) == math.huge then return end
  local unit
  if cmd.args.scale == SensorMultilevel.scale.temperature.CELSIUS then
    unit = "C"
  elseif cmd.args.scale == SensorMultilevel.scale.temperature.FAHRENHEIT then
    unit = "F"
  else
    return
  end
  device:emit_event_for_endpoint(cmd.src_channel,
    capabilities.temperatureMeasurement.temperature(
      { value = value, unit = unit }, { state_change = true }))
end
local fibaro_smoke_sensor = {
  zwave_handlers = {
    [cc.SENSOR_MULTILEVEL] = {
      [SensorMultilevel.REPORT] = temperature_report_handler
    },
    [cc.WAKE_UP] = {
      [WakeUp.NOTIFICATION] = wakeup_notification_handler,
      -- The SDK has no Lua defaults for these reports; the hub also receives
      -- IntervalReport directly for its own device-health interval handling.
      [WakeUp.INTERVAL_REPORT] = wakeup_interval_report_handler,
      [WakeUpV2.INTERVAL_CAPABILITIES_REPORT] = wakeup_capabilities_report_handler
    }
  },
  lifecycle_handlers = {
    added = device_added
  },
  NAME = "fibaro smoke sensor",
  can_handle = require("fibaro-smoke-sensor.can_handle"),
  health_check = false,
}

return fibaro_smoke_sensor
