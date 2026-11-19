import logging

log = logging.getLogger("driver")


class Driver:
    name = "base"

    async def start(self, on_message):
        self.on_message = on_message

    async def stop(self):
        pass

    async def send(self, chat_type: str, chat_id: int, segments: list):
        raise NotImplementedError

    def login_info(self) -> dict:
        raise NotImplementedError

    def groups(self) -> list:
        return []

    def group_info(self, group_id: int) -> dict:
        return {}

    def members(self, group_id: int) -> list:
        return []

    def friends(self) -> list:
        return []
