-- Copyright 2022 SmartThings, Inc.
-- Licensed under the Apache License, Version 2.0


local capabilities = require "st.capabilities"
--- @type st.zwave.CommandClass
local cc = require "st.zwave.CommandClass"
--- @type st.zwave.Driver
local ZwaveDriver = require "st.zwave.driver"
--- @type st.zwave.defaults
local defaults = require "st.zwave.defaults"
--- @type st.zwave.CommandClass.Configuration
local Configuration = (require "st.zwave.CommandClass.Configuration")({ version=4 })
local preferencesMap = require "preferences"
local log = require "log"
local LOCAL_PREFERENCES_REVISION = 1
local LOCAL_PREFERENCES_ATTEMPTED = "stmq_local_preferences_attempted_revision"

local function preference_counts(device, parameters)
  local mapped_count, local_count = 0, 0
  for id in pairs(parameters or {}) do
    mapped_count = mapped_count + 1
    if device.preferences[id] ~= nil then local_count = local_count + 1 end
  end
  return mapped_count, local_count
end

local function log_preference_state(device, parameters, phase)
  local mapped_count, local_count = preference_counts(device, parameters)
  log.info(string.format("Preference application %s: mapped=%d local=%d attempted=%s",
    phase, mapped_count, local_count,
    tostring(device:get_field(LOCAL_PREFERENCES_ATTEMPTED) ~= nil)))
end

--- Update preference
---
--- @param device st.zwave.Device
--- @param args
local function update_preferences(self, device, args, is_awake)
  local preferences = preferencesMap.get_device_parameters(device)
  local old_preferences = args and args.old_st_store and args.old_st_store.preferences
  -- The SDK snapshots current preferences at init. A newly installed profile's
  -- defaults can therefore be visible without appearing as changes at wake-up.
  -- Attempt the complete new local selection once, only from the awake callback.
  local _, local_count = preference_counts(device, preferences)
  local pending_local_selection = device:get_field(LOCAL_PREFERENCES_ATTEMPTED) ~= LOCAL_PREFERENCES_REVISION
  if is_awake and pending_local_selection and not device:get_field("__stmq_preference_pending_logged") then
    log_preference_state(device, preferences, "first pending wake")
    device:set_field("__stmq_preference_pending_logged", true)
  end
  local apply_local_selection = is_awake and local_count == 9 and pending_local_selection
  -- Iterate mapped parameters so the separate wake-up preference is never sent
  -- as a Configuration parameter. IDs match the currently bundled profiles.
  for id, parameter in pairs(preferences or {}) do
    local value = device.preferences[id]
    local old_value = old_preferences and old_preferences[id]
    if value ~= nil and (apply_local_selection or not old_preferences or old_value ~= value) then
      local new_parameter_value = preferencesMap.to_numeric_value(value)
      device:send(Configuration:Set({parameter_number = parameter.parameter_number, size = parameter.size, configuration_value = new_parameter_value}))
    end
  end
  if apply_local_selection then
    -- Records a write attempt while awake, not detector acknowledgement.
    device:set_field(LOCAL_PREFERENCES_ATTEMPTED, LOCAL_PREFERENCES_REVISION, {persist = true})
  end
end

--- Initialize device
---
--- @param self st.zwave.Driver
--- @param device st.zwave.Device
local device_init = function(self, device)
  device:set_update_preferences_fn(function(driver, awake_device, args)
    update_preferences(driver, awake_device, args, true)
  end)
  log_preference_state(device, preferencesMap.get_device_parameters(device), "initialized")
end

--- Add device
---
--- @param self st.zwave.Driver
--- @param device st.zwave.Device
local device_added = function(self, device)
  if device:supports_capability_by_id("smokeDetector") then
    device:emit_event(capabilities.smokeDetector.smoke.clear())
  end
  if device:supports_capability_by_id("carbonMonoxideDetector") then
    device:emit_event(capabilities.carbonMonoxideDetector.carbonMonoxide.clear())
  end
end

--- Handle preference changes
---
--- @param driver st.zwave.Driver
--- @param device st.zwave.Device
--- @param event table
--- @param args
local function info_changed(self, device, event, args)
  if not device:is_cc_supported(cc.WAKE_UP) then
    update_preferences(self, device, args)
  end
end

local function do_configure(driver, device)
  update_preferences(driver, device)
end

local driver_template = {
  supported_capabilities = {
    capabilities.smokeDetector,
    capabilities.carbonMonoxideDetector,
    capabilities.battery,
    capabilities.tamperAlert,
    capabilities.temperatureAlarm,
    capabilities.temperatureMeasurement
  },
  sub_drivers = require("sub_drivers"),
  lifecycle_handlers = {
    init = device_init,
    infoChanged = info_changed,
    doConfigure = do_configure,
    added = device_added
  },
  shared_device_thread_enabled = true,
}

defaults.register_for_default_handlers(driver_template, driver_template.supported_capabilities)
local detector = ZwaveDriver("zwave_smoke_co_detector", driver_template)
detector:run()
