"""Select the requested contact from Meross garage command acknowledgements."""


def stmq_garage_command_state(payload, channel):
    # MSG200 4.2.8 returns every contact followed by a scalar execute flag.
    # Older firmware returns one dictionary or one dictionary in a list.
    if isinstance(payload, list):
        matches = [row for row in payload if isinstance(row, dict)
                   and row.get("channel") == channel]
        if len(matches) != 1:
            raise ValueError("Garage acknowledgement must identify one matching channel")
        state = dict(matches[0])
        execute = [row for row in payload if type(row) is int and row in (0, 1)]
        if "execute" not in state and len(execute) == 1:
            state["execute"] = execute[0]
    elif isinstance(payload, dict) and payload.get("channel", channel) == channel:
        state = dict(payload)
    else:
        raise ValueError("Garage acknowledgement channel does not match")
    if type(state.get("open")) is not int or state["open"] not in (0, 1):
        raise ValueError("Garage acknowledgement has no binary contact")
    return state


class StmqGarageConfigMixin(me.MEListChannelMixin):
    async def async_request_value(self, value):
        if self.ns.name != "Appliance.GarageDoor.MultipleConfig":
            return await super().async_request_value(value)
        # This firmware acknowledges a list-shaped write without applying it.
        return await self.manager.async_request_ack(
            self.ns.name, mc.METHOD_SET,
            {self.ns.key: {mc.KEY_CHANNEL: self.channel, self.key_value: value}},
        )
