// The approved sculpt creates its own materials, textures and deforming meshes.
// Register them with the scene owner without batching away their live anatomy.
export function ownForestBudResources(workshop, root, lowQuality = false) {
  const owned = { geometries:new Set(), materials:new Set(), textures:new Set(), skeletons:new Set() };
  root.traverse(node => {
    if (node.geometry) owned.geometries.add(node.geometry);
    if (node.skeleton) owned.skeletons.add(node.skeleton);
    for (const material of node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : []) {
      owned.materials.add(material);
      for (const value of Object.values(material)) if (value?.isTexture) owned.textures.add(value);
      if (material.isMeshPhysicalMaterial && lowQuality) {
        material.clearcoat = 0; material.sheen = 0;
      }
      // The sculpted smile uses derivatives for the same soft edge on WebGL1.
      if (material.onBeforeCompile) {
        material.extensions ||= {}; material.extensions.derivatives = true;
      }
    }
  });
  // Three normally allocates this lazily while rendering. Allocate it here so
  // Workshop also releases it if a consumer only disposes the scene owner.
  for (const skeleton of owned.skeletons) {
    if (!skeleton.boneTexture) skeleton.computeBoneTexture();
    if (skeleton.boneTexture) owned.textures.add(skeleton.boneTexture);
  }
  for (const key of ['geometries','materials','textures']) {
    for (const resource of owned[key]) workshop[key].add(resource);
  }
  let disposed = false;
  return {
    skeletons:owned.skeletons,
    dispose() {
      if (disposed) return; disposed = true;
      for (const skeleton of owned.skeletons) {
        const texture = skeleton.boneTexture;
        if (texture && workshop.textures.has(texture)) {
          workshop.textures.delete(texture); owned.textures.delete(texture);
        } else skeleton.boneTexture = null;
        skeleton.dispose();
        skeleton.bones.length = 0; skeleton.boneInverses.length = 0;
      }
      for (const key of ['geometries','materials','textures']) {
        for (const resource of owned[key]) if (workshop[key].delete(resource)) resource.dispose();
        owned[key].clear();
      }
      owned.skeletons.clear();
    }
  };
}
