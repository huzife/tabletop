use crate::math::{EPSILON, Vec2};
use crate::model::{BilliardsMode, PocketKind, PocketSpec, SpotSpec, TableSpec};

const CHINESE_WIDTH: f64 = 2.54;
const CHINESE_HEIGHT: f64 = 1.26;
const CHINESE_HEAD_OFFSET: f64 = 0.635;
const SNOOKER_WIDTH: f64 = 3.569;
const SNOOKER_HEIGHT: f64 = 1.778;
const SNOOKER_BAULK_LINE: f64 = 0.737;
const SNOOKER_D_RADIUS: f64 = 0.292;
const POCKET_SHELF_CLEARANCE_FACTOR: f64 = 1.1;

#[derive(Clone, Copy, Debug)]
pub(crate) struct Aabb {
    pub minimum: Vec2,
    pub maximum: Vec2,
}

impl Aabb {
    pub fn from_motion(
        position: Vec2,
        velocity: Vec2,
        acceleration: Vec2,
        time: f64,
        pad: f64,
    ) -> Self {
        let end = position + velocity * time + acceleration * (0.5 * time * time);
        let extremum_x = axis_extremum(position.x, velocity.x, acceleration.x, time);
        let extremum_y = axis_extremum(position.y, velocity.y, acceleration.y, time);
        let minimum = Vec2::new(
            position.x.min(end.x).min(extremum_x) - pad,
            position.y.min(end.y).min(extremum_y) - pad,
        );
        let maximum = Vec2::new(
            position.x.max(end.x).max(extremum_x) + pad,
            position.y.max(end.y).max(extremum_y) + pad,
        );
        Self { minimum, maximum }
    }

    pub fn around(center: Vec2, radius: f64) -> Self {
        Self {
            minimum: Vec2::new(center.x - radius, center.y - radius),
            maximum: Vec2::new(center.x + radius, center.y + radius),
        }
    }

    pub fn overlaps(self, other: Self) -> bool {
        self.minimum.x <= other.maximum.x + EPSILON
            && self.maximum.x + EPSILON >= other.minimum.x
            && self.minimum.y <= other.maximum.y + EPSILON
            && self.maximum.y + EPSILON >= other.minimum.y
    }
}

fn axis_extremum(position: f64, velocity: f64, acceleration: f64, time: f64) -> f64 {
    if acceleration.abs() <= EPSILON {
        return position;
    }
    let extremum_time = (-velocity / acceleration).clamp(0.0, time);
    position + velocity * extremum_time + 0.5 * acceleration * extremum_time * extremum_time
}

#[derive(Clone, Debug)]
pub(crate) struct LinearCushion {
    pub id: String,
    pub start: Vec2,
    pub end: Vec2,
    pub inward_normal: Vec2,
    pub aabb: Aabb,
}

impl LinearCushion {
    fn new(id: impl Into<String>, start: Vec2, end: Vec2, inward_normal: Vec2) -> Self {
        let normal = inward_normal.normalized();
        Self {
            id: id.into(),
            start,
            end,
            inward_normal: normal,
            aabb: Aabb {
                minimum: Vec2::new(start.x.min(end.x), start.y.min(end.y)),
                maximum: Vec2::new(start.x.max(end.x), start.y.max(end.y)),
            },
        }
    }

    pub fn contains_projection(&self, point: Vec2, tolerance: f64) -> bool {
        let edge = self.end - self.start;
        let length_squared = edge.length_squared();
        if length_squared <= EPSILON {
            return false;
        }
        let fraction = (point - self.start).dot(edge) / length_squared;
        fraction >= -tolerance && fraction <= 1.0 + tolerance
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CircularCushion {
    pub id: String,
    pub center: Vec2,
    pub radius: f64,
    pub aabb: Aabb,
}

#[derive(Clone, Debug)]
pub(crate) struct PocketGeometry {
    pub id: String,
    pub center: Vec2,
    pub capture_radius: f64,
    pub aabb: Aabb,
}

#[derive(Clone, Debug)]
pub(crate) struct TableGeometry {
    pub table: TableSpec,
    pub linear_cushions: Vec<LinearCushion>,
    pub circular_cushions: Vec<CircularCushion>,
    pub pockets: Vec<PocketGeometry>,
}

impl TableGeometry {
    pub fn for_mode(mode: BilliardsMode) -> Self {
        let table = table_spec(mode);
        let corner_mouth = table.pockets[0].capture_radius * 0.92;
        let side_mouth = table.pockets[1].capture_radius * 0.88;
        let middle = table.width * 0.5;
        let mut linear_cushions = vec![
            LinearCushion::new(
                "top-left",
                Vec2::new(corner_mouth, 0.0),
                Vec2::new(middle - side_mouth, 0.0),
                Vec2::new(0.0, 1.0),
            ),
            LinearCushion::new(
                "top-right",
                Vec2::new(middle + side_mouth, 0.0),
                Vec2::new(table.width - corner_mouth, 0.0),
                Vec2::new(0.0, 1.0),
            ),
            LinearCushion::new(
                "bottom-left",
                Vec2::new(corner_mouth, table.height),
                Vec2::new(middle - side_mouth, table.height),
                Vec2::new(0.0, -1.0),
            ),
            LinearCushion::new(
                "bottom-right",
                Vec2::new(middle + side_mouth, table.height),
                Vec2::new(table.width - corner_mouth, table.height),
                Vec2::new(0.0, -1.0),
            ),
            LinearCushion::new(
                "left",
                Vec2::new(0.0, corner_mouth),
                Vec2::new(0.0, table.height - corner_mouth),
                Vec2::new(1.0, 0.0),
            ),
            LinearCushion::new(
                "right",
                Vec2::new(table.width, corner_mouth),
                Vec2::new(table.width, table.height - corner_mouth),
                Vec2::new(-1.0, 0.0),
            ),
        ];

        // The short diagonal jaws stop near-pocket shots from seeing an
        // unphysical square opening while leaving a genuine throat to each bag.
        let jaw_depth = corner_mouth * 0.48;
        let corner_jaws = [
            (
                "top-left-horizontal-jaw",
                Vec2::new(corner_mouth, 0.0),
                Vec2::new(jaw_depth, -jaw_depth),
                Vec2::new(1.0, 1.0),
            ),
            (
                "top-left-vertical-jaw",
                Vec2::new(0.0, corner_mouth),
                Vec2::new(-jaw_depth, jaw_depth),
                Vec2::new(1.0, 1.0),
            ),
            (
                "top-right-horizontal-jaw",
                Vec2::new(table.width - corner_mouth, 0.0),
                Vec2::new(table.width - jaw_depth, -jaw_depth),
                Vec2::new(-1.0, 1.0),
            ),
            (
                "top-right-vertical-jaw",
                Vec2::new(table.width, corner_mouth),
                Vec2::new(table.width + jaw_depth, jaw_depth),
                Vec2::new(-1.0, 1.0),
            ),
            (
                "bottom-left-horizontal-jaw",
                Vec2::new(corner_mouth, table.height),
                Vec2::new(jaw_depth, table.height + jaw_depth),
                Vec2::new(1.0, -1.0),
            ),
            (
                "bottom-left-vertical-jaw",
                Vec2::new(0.0, table.height - corner_mouth),
                Vec2::new(-jaw_depth, table.height - jaw_depth),
                Vec2::new(1.0, -1.0),
            ),
            (
                "bottom-right-horizontal-jaw",
                Vec2::new(table.width - corner_mouth, table.height),
                Vec2::new(table.width - jaw_depth, table.height + jaw_depth),
                Vec2::new(-1.0, -1.0),
            ),
            (
                "bottom-right-vertical-jaw",
                Vec2::new(table.width, table.height - corner_mouth),
                Vec2::new(table.width + jaw_depth, table.height - jaw_depth),
                Vec2::new(-1.0, -1.0),
            ),
        ];
        linear_cushions.extend(
            corner_jaws
                .into_iter()
                .map(|(id, start, end, normal)| LinearCushion::new(id, start, end, normal)),
        );

        let side_depth = side_mouth * 0.36;
        linear_cushions.extend([
            LinearCushion::new(
                "top-side-left-jaw",
                Vec2::new(middle - side_mouth, 0.0),
                Vec2::new(middle - side_depth, side_depth),
                Vec2::new(0.35, 1.0),
            ),
            LinearCushion::new(
                "top-side-right-jaw",
                Vec2::new(middle + side_mouth, 0.0),
                Vec2::new(middle + side_depth, side_depth),
                Vec2::new(-0.35, 1.0),
            ),
            LinearCushion::new(
                "bottom-side-left-jaw",
                Vec2::new(middle - side_mouth, table.height),
                Vec2::new(middle - side_depth, table.height - side_depth),
                Vec2::new(0.35, -1.0),
            ),
            LinearCushion::new(
                "bottom-side-right-jaw",
                Vec2::new(middle + side_mouth, table.height),
                Vec2::new(middle + side_depth, table.height - side_depth),
                Vec2::new(-0.35, -1.0),
            ),
        ]);

        let knuckle_radius = table.ball_diameter * 0.18;
        let mut circular_cushions = Vec::new();
        for cushion in &linear_cushions {
            for (suffix, center) in [("a", cushion.start), ("b", cushion.end)] {
                if circular_cushions.iter().any(|existing: &CircularCushion| {
                    (existing.center - center).length_squared() <= EPSILON
                }) {
                    continue;
                }
                circular_cushions.push(CircularCushion {
                    id: format!("{}-{suffix}", cushion.id),
                    center,
                    radius: knuckle_radius,
                    aabb: Aabb::around(center, knuckle_radius),
                });
            }
        }

        let pockets = table
            .pockets
            .iter()
            .enumerate()
            .map(|(index, pocket)| {
                let center = Vec2::new(pocket.x, pocket.y);
                // `PocketSpec::capture_radius` describes the mouth aperture.
                // The centre of a finite-radius ball must clear the shelf by
                // one ball radius plus a small rounded-lip allowance before it
                // can fall; using the full aperture radius captures grazing
                // balls while they are still supported.
                let capture_radius = (pocket.capture_radius
                    - table.ball_diameter * 0.5 * POCKET_SHELF_CLEARANCE_FACTOR)
                    .max(EPSILON);
                PocketGeometry {
                    id: format!("pocket-{index}"),
                    center,
                    capture_radius,
                    aabb: Aabb::around(center, capture_radius),
                }
            })
            .collect();

        Self {
            table,
            linear_cushions,
            circular_cushions,
            pockets,
        }
    }
}

pub fn table_spec(mode: BilliardsMode) -> TableSpec {
    match mode {
        BilliardsMode::ChineseEightBall => TableSpec {
            mode,
            width: CHINESE_WIDTH,
            height: CHINESE_HEIGHT,
            ball_diameter: 0.05715,
            ball_mass: 0.163,
            cushion_restitution: 0.82,
            baulk_line_x: Some(CHINESE_HEAD_OFFSET),
            d_radius: None,
            pockets: six_pockets(CHINESE_WIDTH, CHINESE_HEIGHT, 0.068, 0.073),
            spots: vec![SpotSpec {
                id: "foot",
                x: CHINESE_WIDTH - CHINESE_HEAD_OFFSET,
                y: CHINESE_HEIGHT * 0.5,
            }],
        },
        BilliardsMode::Snooker => {
            let blue_x = SNOOKER_WIDTH * 0.5;
            let pink_x = (blue_x + SNOOKER_WIDTH) * 0.5;
            TableSpec {
                mode,
                width: SNOOKER_WIDTH,
                height: SNOOKER_HEIGHT,
                ball_diameter: 0.0525,
                ball_mass: 0.142,
                cushion_restitution: 0.78,
                baulk_line_x: Some(SNOOKER_BAULK_LINE),
                d_radius: Some(SNOOKER_D_RADIUS),
                pockets: six_pockets(SNOOKER_WIDTH, SNOOKER_HEIGHT, 0.066, 0.071),
                spots: vec![
                    SpotSpec {
                        id: "green",
                        x: SNOOKER_BAULK_LINE,
                        y: SNOOKER_HEIGHT * 0.5 - SNOOKER_D_RADIUS,
                    },
                    SpotSpec {
                        id: "brown",
                        x: SNOOKER_BAULK_LINE,
                        y: SNOOKER_HEIGHT * 0.5,
                    },
                    SpotSpec {
                        id: "yellow",
                        x: SNOOKER_BAULK_LINE,
                        y: SNOOKER_HEIGHT * 0.5 + SNOOKER_D_RADIUS,
                    },
                    SpotSpec {
                        id: "blue",
                        x: blue_x,
                        y: SNOOKER_HEIGHT * 0.5,
                    },
                    SpotSpec {
                        id: "pink",
                        x: pink_x,
                        y: SNOOKER_HEIGHT * 0.5,
                    },
                    SpotSpec {
                        id: "black",
                        x: SNOOKER_WIDTH - 0.324,
                        y: SNOOKER_HEIGHT * 0.5,
                    },
                ],
            }
        }
    }
}

fn six_pockets(
    width: f64,
    height: f64,
    corner_capture_radius: f64,
    side_capture_radius: f64,
) -> Vec<PocketSpec> {
    vec![
        PocketSpec {
            capture_radius: corner_capture_radius,
            kind: PocketKind::Corner,
            x: 0.0,
            y: 0.0,
        },
        PocketSpec {
            capture_radius: side_capture_radius,
            kind: PocketKind::Side,
            x: width * 0.5,
            y: 0.0,
        },
        PocketSpec {
            capture_radius: corner_capture_radius,
            kind: PocketKind::Corner,
            x: width,
            y: 0.0,
        },
        PocketSpec {
            capture_radius: corner_capture_radius,
            kind: PocketKind::Corner,
            x: 0.0,
            y: height,
        },
        PocketSpec {
            capture_radius: side_capture_radius,
            kind: PocketKind::Side,
            x: width * 0.5,
            y: height,
        },
        PocketSpec {
            capture_radius: corner_capture_radius,
            kind: PocketKind::Corner,
            x: width,
            y: height,
        },
    ]
}
