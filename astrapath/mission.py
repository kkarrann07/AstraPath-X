from dataclasses import dataclass, replace
from heapq import heappop, heappush
from math import atan, degrees, hypot, inf, isfinite

import numpy as np

from .terrain import DIRECTIONS, illumination, slope_map


EPSILON = 1e-7
POLICIES = ("shortest", "safest", "energy")
ROBUSTNESS_TRIALS = 20


@dataclass(frozen=True)
class Settings:
    capacity: float = 120
    initial_pct: float = 82
    budget: float = 100
    reserve: float = 18
    max_slope: float = 19
    speed: float = 0.85
    traction: float = 18
    hotel: float = 15
    solar_rate: float = 36
    azimuth: float = 112
    altitude: float = 7
    solar: bool = True
    round_trip: bool = False
    uncertainty: float = 1.0

    @property
    def initial(self):
        return self.capacity * self.initial_pct / 100

    @property
    def floor(self):
        return max(self.reserve, self.initial - self.budget)


@dataclass(frozen=True)
class Edge:
    distance: float
    slope: float
    seconds: float
    gross: float
    solar: float
    lit: bool

    @property
    def net(self):
        return self.gross - self.solar

    def cost(self, policy):
        if policy == "safest":
            return self.distance * (1 + (self.slope / 4) ** 2)
        if policy == "energy":
            return max(0, self.net) + 0.00001 * self.distance
        return self.distance


class Network:
    def __init__(self, terrain, settings, nodes=None):
        self.terrain = terrain
        self.settings = settings
        self.slopes = slope_map(terrain)
        self.lit = illumination(terrain, settings.azimuth, settings.altitude)
        self.allowed = np.isfinite(self.slopes) & (self.slopes <= settings.max_slope)
        self.outgoing = {}
        self.incoming = {}
        z = terrain.elevation
        gravity_ratio = terrain.gravity / 9.80
        h, w = z.shape
        for r, c in (np.argwhere(self.allowed).tolist() if nodes is None else nodes):
            if not self.allowed[r, c]:
                continue
            node = (r, c)
            neighbors = self.outgoing.setdefault(node, {})
            for dr, dc in DIRECTIONS:
                rr, cc = r + dr, c + dc
                if not (0 <= rr < h and 0 <= cc < w and self.allowed[rr, cc]):
                    continue
                if dr and dc and not (self.allowed[r, cc] and self.allowed[rr, c]):
                    continue
                other = (rr, cc)
                distance = hypot(dr * terrain.dy, dc * terrain.dx)
                grade = float(z[other] - z[node]) / distance
                seconds = distance / settings.speed * (1 + 0.7 * abs(grade))
                gross = settings.traction * distance / 1000 * (
                    1 + gravity_ratio * (3.5 * max(grade, 0) + 0.6 * max(-grade, 0))
                ) + settings.hotel * seconds / 3600
                lit = bool(self.lit[node] and self.lit[other])
                solar = settings.solar_rate * seconds / 3600 if lit and settings.solar else 0
                edge = Edge(distance, abs(degrees(atan(grade))), seconds, gross, solar, lit)
                neighbors[other] = edge
                self.incoming.setdefault(other, {})[node] = edge

    def edge(self, a, b):
        return self.outgoing.get(a, {}).get(b)

    def tree(self, root, policy, reverse=False, goal=None):
        """Dijkstra for complete trees, A* when a forward goal is supplied."""
        adjacency = self.incoming if reverse else self.outgoing
        factor = 0.00001 if policy == "energy" else 1

        def estimate(node):
            if goal is None:
                return 0
            return factor * hypot((node[0] - goal[0]) * self.terrain.dy,
                                  (node[1] - goal[1]) * self.terrain.dx)

        costs = {root: 0}
        parents = {root: None}
        queue = [(estimate(root), 0, root)]
        while queue:
            _, cost, node = heappop(queue)
            if cost != costs[node]:
                continue
            if node == goal:
                break
            for neighbor, edge in adjacency.get(node, {}).items():
                candidate = cost + edge.cost(policy)
                if candidate < costs.get(neighbor, inf):
                    costs[neighbor] = candidate
                    parents[neighbor] = node
                    heappush(queue, (candidate + estimate(neighbor), candidate, neighbor))
        return parents

    def path(self, start, target, policy):
        if start not in self.outgoing or target not in self.outgoing:
            return []
        return trace(self.tree(start, policy, goal=target), target)[::-1]

    def return_plans(self, base):
        """Lowest required charge across three modeled return trees at each cell."""
        floor = self.settings.floor
        capacity = self.settings.capacity
        best = {}
        trees = {}
        for policy in POLICIES:
            parents = self.tree(base, policy, reverse=True)
            trees[policy] = parents
            required = {base: floor}
            for child in parents:
                pending = []
                node = child
                while node not in required:
                    parent = parents[node]
                    pending.append((node, self.edge(node, parent)))
                    node = parent
                for node, edge in reversed(pending):
                    threshold = max(floor, required[parents[node]] + edge.net)
                    required[node] = threshold if threshold <= capacity + EPSILON else inf
                best[child] = min(best.get(child, inf), required[child])
        return best, trees

    def return_requirements(self, base):
        requirements, _ = self.return_plans(base)
        return requirements


def trace(parents, node):
    if node not in parents:
        return []
    path = []
    while node is not None:
        path.append(node)
        node = parents[node]
    return path


def simulate(network, path, initial, return_required=None, enforce_return=None):
    if not path or path[0] not in network.outgoing:
        return None
    settings = network.settings
    battery = min(settings.capacity, max(0, initial))
    if enforce_return is None:
        enforce_return = settings.round_trip
    distance = duration = energy = collected = slope = lit_distance = shadow = longest_shadow = 0
    first_failure = 0 if battery + EPSILON < settings.floor else None
    first_pnr = None
    timeline = []
    failure = ""
    rows = [(None, path[0]), *zip(path, path[1:])]
    for index, (previous, node) in enumerate(rows):
        if previous is not None:
            edge = network.edge(previous, node)
            if edge is None:
                return None
            distance += edge.distance
            duration += edge.seconds
            energy += edge.gross
            slope = max(slope, edge.slope)
            collected += max(0, min(edge.solar, settings.capacity - battery + edge.gross))
            raw = battery - edge.net
            battery = min(settings.capacity, max(0, raw))
            if edge.lit:
                lit_distance += edge.distance
                shadow = 0
            else:
                shadow += edge.seconds
                longest_shadow = max(shadow, longest_shadow)
            if raw + EPSILON < settings.floor and first_failure is None:
                first_failure = index
                failure = "Battery would deplete" if raw < 0 else "Reserve or energy budget breached"
        threshold = (return_required or {}).get(node, inf)
        if battery + EPSILON < threshold and first_pnr is None:
            first_pnr = index
        timeline.append({
            "row": node[0], "col": node[1], "battery": round(battery, 5),
            "distance": round(distance, 5), "seconds": round(duration, 3),
            "gross": round(energy, 5), "solar": round(collected, 5),
            "required": round(threshold, 5) if isfinite(threshold) else None,
            "lit": edge.lit if previous is not None else bool(network.lit[node]),
            "shadow_seconds": round(shadow, 3),
        })
    if first_failure == 0:
        failure = "Starting battery is below the mission floor"
    if enforce_return and first_pnr is not None and (first_failure is None or first_pnr < first_failure):
        first_failure = first_pnr
        failure = "Modeled return cannot preserve the mission floor"
    return {
        "path": path, "timeline": timeline, "distance": round(distance, 2),
        "gross": round(energy, 2), "solar": round(collected, 2),
        "net": round(initial - battery, 2), "end": round(battery, 2),
        "min_battery": round(min(point["battery"] for point in timeline), 2),
        "max_slope": round(slope, 2), "seconds": round(duration, 2),
        "lit_pct": round(100 * lit_distance / distance) if distance else 0,
        "shadow_seconds": round(longest_shadow), "pnr": first_pnr,
        "feasible": first_failure is None, "failure_index": first_failure, "reason": failure,
    }


def alternatives(network, start, target, initial, return_requirements, enforce_return=None):
    return {policy: simulate(network, network.path(start, target, policy), initial, return_requirements, enforce_return)
            for policy in POLICIES}


def sampled_robustness(network, paths, base):
    """Retest fixed outbound paths with adaptive modeled returns on perturbed terrain."""
    settings = network.settings
    if settings.uncertainty == 0 or not paths:
        return {}
    generator = np.random.default_rng(2026)
    counts = dict.fromkeys(paths, 0)
    nodes = None if settings.round_trip else {base, *(node for path in paths.values() for node in path)}
    for _ in range(ROBUSTNESS_TRIALS):
        terrain = network.terrain
        noise = generator.normal(0, settings.uncertainty, terrain.elevation.shape)
        sampled = Network(replace(terrain, elevation=terrain.elevation + noise), settings, nodes)
        if base not in sampled.outgoing:
            continue
        returns = sampled.return_requirements(base) if settings.round_trip else None
        for policy, path in paths.items():
            result = simulate(sampled, path, settings.initial, returns)
            counts[policy] += bool(result and result["feasible"])
    return counts


def emergency(network, base, position, target, battery, returning=False):
    settings = network.settings
    returns, trees = network.return_plans(base)
    options = {} if returning else alternatives(network, position, target, battery, returns)
    valid = [route for route in options.values() if route and route["feasible"]]
    escapes = {policy: simulate(network, trace(parents, position), battery, returns, enforce_return=False)
               for policy, parents in trees.items()}
    back = [route for route in escapes.values() if route and route["feasible"]]

    def describe(route, endpoint):
        return (f"{route['distance']:.0f} m to {endpoint} at up to {route['max_slope']:.1f}° slope. "
                f"Lowest projected charge {route['min_battery']:.1f} Wh against a {settings.floor:.1f} Wh floor, "
                f"with {route['solar']:.1f} Wh of estimated solar input.")

    if valid:
        route = min(valid, key=lambda result: (-result["min_battery"], result["distance"]))
        reason = describe(route, "target")
        if settings.round_trip:
            threshold = route["timeline"][-1]["required"]
            reason += f" Target charge {route['end']:.1f} Wh covers the {threshold:.1f} Wh return threshold."
        return {"status": "CONTINUE", "route": route, "reason": reason}
    if back:
        route = min(back, key=lambda result: (-result["min_battery"], result["distance"]))
        reason = "Return to base selected. " if returning else "Modeled target routes breach a mission constraint. "
        return {"status": "RETURN", "route": route, "reason": reason + describe(route, "base")}
    lit = bool(network.lit[position])
    idle_watts = (settings.solar_rate if lit and settings.solar else 0) - settings.hotel
    ten_min = max(0, min(settings.capacity, battery + idle_watts / 6))
    if idle_watts < 0 and battery <= -idle_watts / 6:
        duration = 60 * battery / -idle_watts
        hold = f"Stationary charge reaches zero after about {duration:.1f} min."
    else:
        hold = f"Projected charge after 10 minutes stationary is {ten_min:.1f} Wh."
    modeled = [route for route in [*options.values(), *escapes.values()] if route is not None]
    route_detail = ("Modeled routes fail the battery or return constraint."
                    if modeled else "The terrain model found no traversable path to a requested endpoint.")
    return {"status": "STOP/HOLD", "route": None,
            "reason": (f"{route_detail} Current charge {battery:.1f} Wh and mission floor "
                       f"{settings.floor:.1f} Wh. {hold}"),
            "idle_watts": idle_watts}
