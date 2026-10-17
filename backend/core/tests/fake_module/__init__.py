"""A test-only module (installed by config/settings/test.py only) proving the platform core is generic.

It plugs into core exactly like a real module would, from its AppConfig `ready()`, with no change to core: a target
type (`fake.widget`), an event type with a notification handler, a search provider and a trash kind.
"""
