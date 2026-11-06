import * as THREE from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { fitModel } from './world'

/**
 * Axe whose origin is the grip (near the handle end). Local +Z runs from grip to head;
 * the blade edge points along local -Y. The generated model lies along Z with its head at +Z.
 */
export function makeAxe(gltf: GLTF, length: number, clone = false): THREE.Group {
  const model = fitModel(clone ? gltf.scene.clone() : gltf.scene, 'z', length)
  // fitModel puts the base at y=0; re-centre vertically so the handle axis is the pivot line.
  const box = new THREE.Box3().setFromObject(model)
  const c = box.getCenter(new THREE.Vector3())
  model.position.y -= c.y - 0.02 * length
  // Handle end at z = -length/2 → move it to the grip, leaving a short pommel below the hand.
  model.position.z += length * 0.44
  const pivot = new THREE.Group()
  pivot.add(model)
  return pivot
}

/** Distance from grip to the centre of the axe head (where it bites). */
export const HEAD_FRACTION = 0.86
