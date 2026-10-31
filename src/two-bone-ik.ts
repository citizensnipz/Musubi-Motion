/*
 * Scalar Three.js adaptation of ozz-animation IKTwoBoneJob's midpoint-angle,
 * root-target and pole-plane quaternion correction stages (soften=1, twist=0).
 * Source revision: 744eb9d99f606eda849acb0b1204f7a3dc20bca1
 * https://github.com/guillaumeblanc/ozz-animation/blob/744eb9d99f606eda849acb0b1204f7a3dc20bca1/src/animation/runtime/ik_two_bone_job.cc
 * Adaptation: infer the hinge from current FK bone axes; guard zero/parallel
 * directions explicitly; use Three quaternion/vector operations and external
 * Musubi FK/IK blending. No soft reach, twist control or joint limits.
 *
 * Copyright (c) Guillaume Blanc
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { MathUtils, Matrix4, Quaternion, Vector3 } from "three";

function perpendicular(direction: Vector3): Vector3 {
  const reference = Math.abs(direction.x) < 0.8 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  return reference.addScaledVector(direction, -reference.dot(direction)).normalize();
}

/** Local post-multiplied corrections for a rigid, unscaled three-joint chain. */
export function solveTwoBoneCorrections(startWorld: Matrix4, midWorld: Matrix4, endWorld: Matrix4, target: Vector3, poleTarget: Vector3): { root: Quaternion; middle: Quaternion } {
  const identity = () => ({ root: new Quaternion(), middle: new Quaternion() });
  if ([startWorld, midWorld, endWorld].some(matrix => !matrix.elements.every(Number.isFinite) || Math.abs(matrix.determinant()) < 1e-12)) return identity();
  const invStart = startWorld.clone().invert(), invMid = midWorld.clone().invert();
  const start = new Vector3().setFromMatrixPosition(startWorld), middle = new Vector3().setFromMatrixPosition(midWorld), end = new Vector3().setFromMatrixPosition(endWorld);
  const startMidMS = start.clone().applyMatrix4(invMid).negate(), midEndMS = end.clone().applyMatrix4(invMid);
  const startMidSS = middle.clone().applyMatrix4(invStart), startEndSS = end.clone().applyMatrix4(invStart);
  const upperSquared = startMidSS.lengthSq(), lowerSquared = startEndSS.clone().sub(startMidSS).lengthSq();
  if (upperSquared < 1e-12 || lowerSquared < 1e-12) return identity();
  const startRotation = new Quaternion().setFromRotationMatrix(startWorld), midRotation = new Quaternion().setFromRotationMatrix(midWorld);
  const inverseStartRotation = startRotation.clone().invert();
  const midToStart = inverseStartRotation.clone().multiply(midRotation);
  const targetSS = target.clone().applyMatrix4(invStart), poleSS = poleTarget.clone().sub(start).applyQuaternion(inverseStartRotation);

  // ozz accepts an authored hinge axis. Infer its positive bend direction from
  // FK here, so arbitrary local bone axes need no extra rig metadata.
  const midAxis = new Vector3().crossVectors(midEndMS, startMidMS);
  if (midAxis.lengthSq() <= 1e-16 * upperSquared * lowerSquared) {
    const upperDirection = startMidSS.clone().normalize();
    const bend = poleSS.clone().addScaledVector(upperDirection, -poleSS.dot(upperDirection));
    if (bend.lengthSq() < 1e-12) bend.copy(perpendicular(upperDirection));
    midAxis.crossVectors(upperDirection, bend.normalize()).applyQuaternion(midToStart.clone().invert());
  }
  midAxis.normalize();
  // ComputeMidJoint: generalized cosine law clamps both unreachable extremes.
  const denominator = 2 * Math.sqrt(upperSquared * lowerSquared);
  const desiredAngle = Math.acos(MathUtils.clamp((upperSquared + lowerSquared - targetSS.lengthSq()) / denominator, -1, 1));
  let initialAngle = Math.acos(MathUtils.clamp((upperSquared + lowerSquared - startEndSS.lengthSq()) / denominator, -1, 1));
  if (new Vector3().crossVectors(startMidMS, midAxis).dot(midEndMS) < 0) initialAngle = -initialAngle;
  const middleCorrection = new Quaternion().setFromAxisAngle(midAxis, desiredAngle - initialAngle);

  // ComputeStartJoint: first aim the corrected endpoint at the target.
  const correctedEndSS = midEndMS.clone().applyQuaternion(middleCorrection).applyQuaternion(midToStart).add(startMidSS);
  const rootCorrection = new Quaternion();
  if (targetSS.lengthSq() > 1e-20 && correctedEndSS.lengthSq() > 1e-20) rootCorrection.setFromUnitVectors(correctedEndSS.clone().normalize(), targetSS.clone().normalize());
  if (targetSS.lengthSq() > 1e-20) {
    const direction = targetSS.clone().normalize();
    const chainNormal = midAxis.clone().applyQuaternion(midToStart).applyQuaternion(rootCorrection).normalize();
    const referenceNormal = new Vector3().crossVectors(direction, poleSS);
    // The upstream pole-parallel case is undefined. Retain the FK hinge plane,
    // projected perpendicular to the target; use a fixed basis only if needed.
    if (referenceNormal.lengthSq() < 1e-12) {
      referenceNormal.copy(chainNormal).addScaledVector(direction, -chainNormal.dot(direction));
      if (referenceNormal.lengthSq() < 1e-12) referenceNormal.copy(perpendicular(direction));
    }
    referenceNormal.normalize();
    const angle = Math.atan2(direction.dot(new Vector3().crossVectors(chainNormal, referenceNormal)), MathUtils.clamp(chainNormal.dot(referenceNormal), -1, 1));
    rootCorrection.premultiply(new Quaternion().setFromAxisAngle(direction, angle)).normalize();
  }
  if (![...rootCorrection.toArray(), ...middleCorrection.toArray()].every(Number.isFinite)) return identity();
  return { root: rootCorrection, middle: middleCorrection.normalize() };
}
