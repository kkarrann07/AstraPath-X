from dataclasses import replace

import numpy as np
import pytest

from astrapath.mission import Network, Settings, alternatives, emergency, sampled_robustness, simulate
from astrapath.terrain import Terrain, demo_terrain, illumination, slope_map


def grid(values, dx=30, dy=30):
    return Terrain(np.array(values, dtype=float), dx, dy, "Test grid", "Test fixture", "")


def flat():
    return grid(np.full((5, 10), 200))


def model(**changes):
    return replace(Settings(), capacity=100, initial_pct=100, budget=100, reserve=10,
                   traction=100, hotel=0, solar=False, **changes)


def test_metric_slopes_and_hard_terrain_limit():
    terrain = grid([[0, 10, 20], [0, 10, 20], [0, 10, 20]], dx=10, dy=50)
    assert slope_map(terrain)[1, 1] == pytest.approx(45)
    assert not Network(terrain, Settings(max_slope=20)).allowed.any()
    assert Network(terrain, Settings(max_slope=46)).edge((1, 0), (1, 1)).slope == pytest.approx(45)


def test_missing_pixels_block_routes_and_diagonal_corner_cutting():
    terrain = grid([[0, 0, np.nan, 0], [0, 0, np.nan, 0], [0, 0, np.nan, 0]])
    network = Network(terrain, Settings())
    assert not network.path((1, 0), (1, 3), "shortest")
    assert not network.allowed[1, 2]
    corner = Network(grid([[0, np.nan, 0], [0, 0, 0], [0, 0, 0]]), Settings())
    assert corner.edge((0, 0), (1, 1)) is None


def test_zero_battery_and_energy_draw_budget_are_binding():
    settings = replace(model(), budget=8)
    network = Network(flat(), settings)
    path = network.path((2, 0), (2, 4), "shortest")
    result = simulate(network, path, settings.initial)
    assert settings.floor == 92
    assert result["failure_index"] == 3
    assert not result["feasible"]
    assert simulate(network, path, 0)["failure_index"] == 0


def test_first_return_crossing_and_round_trip_rejection():
    settings = replace(model(), capacity=53)
    base, target = (2, 0), (2, 9)
    network = Network(flat(), settings)
    requirement = network.return_requirements(base)
    options = alternatives(network, base, target, settings.initial, requirement)
    route = options["shortest"]
    assert requirement[target] == pytest.approx(37)
    assert route["feasible"] and route["end"] == pytest.approx(26)
    assert route["pnr"] == 8
    assert route["timeline"][7]["battery"] >= route["timeline"][7]["required"]
    assert not simulate(network, route["path"], 53, requirement, enforce_return=True)["feasible"]
    result = emergency(network, base, (2, 3), target, 20)
    assert result["status"] == "RETURN"
    assert result["route"]["path"][-1] == base


def test_solar_charges_and_caps_battery_under_full_sun():
    settings = replace(model(), solar=True, solar_rate=2000, altitude=90)
    network = Network(flat(), settings)
    path = network.path((2, 0), (2, 4), "energy")
    route = simulate(network, path, 95)
    assert route["end"] == 100
    assert route["solar"] == pytest.approx(route["gross"] + 5)
    assert all(0 <= point["battery"] <= 100 for point in route["timeline"])


def test_shadow_and_onboard_draw():
    terrain = grid([[0, 100, 0, 0, 0]] * 4)
    lit = illumination(terrain, azimuth=270, altitude=10)
    assert lit[1, 1] and not lit[1, 2] and not lit[1, 4]
    settings = replace(model(), solar=True, solar_rate=1000, altitude=0, hotel=60, speed=.1)
    network = Network(flat(), settings)
    path = network.path((2, 0), (2, 9), "energy")
    route = simulate(network, path, 16)
    assert route["shadow_seconds"] >= 120
    assert route["solar"] == 0
    assert not route["feasible"] and route["failure_index"] == 1
    decision = emergency(network, (2, 0), (2, 4), (2, 9), 2)
    assert decision["status"] == "STOP/HOLD"
    assert "2.0 min" in decision["reason"]


def test_seeded_trials_reproduce_and_zero_sigma_is_off():
    settings = Settings(uncertainty=1)
    network = Network(flat(), settings)
    paths = {"shortest": network.path((2, 0), (2, 9), "shortest")}
    first = sampled_robustness(network, paths, (2, 0))
    assert first == sampled_robustness(network, paths, (2, 0))
    assert first["shortest"] == 20
    assert sampled_robustness(Network(flat(), replace(settings, uncertainty=0)), paths, (2, 0)) == {}


def test_demo_charging_and_routing_change_when_solar_toggles():
    base, target = (42, 10), (30, 90)
    terrain = demo_terrain()
    active = Network(terrain, Settings())
    inactive = Network(terrain, Settings(solar=False))
    routes = alternatives(active, base, target, active.settings.initial, active.return_requirements(base))
    assert len({tuple(route["path"]) for route in routes.values()}) == 3
    assert routes["shortest"]["pnr"] is not None
    assert routes["energy"]["lit_pct"] > routes["shortest"]["lit_pct"]
    assert routes["energy"]["end"] > routes["shortest"]["end"]
    assert inactive.path(base, target, "energy") != routes["energy"]["path"]
