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

local FIBARO_SMOKE_SENSOR_WAKEUP_INTERVAL = 21600 --seconds


--- Determine whether the passed device is fibaro smoke sensro
---
--- @param driver st.zwave.Driver
--- @param device st.zwave.Device
--- @return boolean true if the device is fibaro smoke sensor

local function device_added(self, device)
  device:send(WakeUp:IntervalSet({node_id = self.environment_info.hub_zwave_id, seconds = FIBARO_SMOKE_SENSOR_WAKEUP_INTERVAL}))
  device:emit_event(capabilities.smokeDetector.smoke.clear())
  device:emit_event(capabilities.tamperAlert.tamper.clear())
  device:emit_event(capabilities.temperatureAlarm.temperatureAlarm.cleared())
  device:send(Battery:Get({}))
  device:send(SensorMultilevel:Get({sensor_type = SensorMultilevel.sensor_type.TEMPERATURE}))
end

local function wakeup_notification_handler(self, device, cmd)
  --Note sending WakeUpIntervalGet the first time a device wakes up will happen by default in Lua libs 0.49.x and higher
  --This is done to help the hub correctly set the checkInterval for migrated devices.
  if not device:get_field("__wakeup_interval_get_sent") then
    device:send(WakeUp:IntervalGetV1({}))
    device:set_field("__wakeup_interval_get_sent", true)
  end
  device:emit_event(capabilities.smokeDetector.smoke.clear())
  device:send(Battery:Get({}))
  device:send(SensorMultilevel:Get({sensor_type = SensorMultilevel.sensor_type.TEMPERATURE}))
  -- Read the detector's actual supported limits once per driver runtime.
  -- The decoded response is available in private logcat; no interval is changed.
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
      [WakeUp.NOTIFICATION] = wakeup_notification_handler
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
