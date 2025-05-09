//@ScriptComponent
const Amaz = effect.Amaz;
const used = (x) => { } // mark a variable was used, to avoid the optimization of V8 Engine

/**
 * HeadNeckTracker will set weights for specific head-neck bones
 * EHI PRD - https://bytedance.feishu.cn/docx/AVGtdBNbyoqRFexxhc6cPLdlnuf
 * Dependencies - Camera, Transform.  both added via script
 * Algorithm dependencies - Face
 */

const SCRIPT_NAME = 'HeadNeckTracker';
const JOINT_BONE_NAME = ["HN_joint1", "HN_joint2", "HN_joint3", "HN_joint4", "HN_joint5", "HN_joint6"];

class HeadNeckTracker {
    /**
     * Init components
     */
    initComps() {
        // find camera component
        this.cameraComp = this.getCamera();
        console.log('HeadNeckTracker initComp() camera name: ', this.cameraComp.entity.name);

        if (!this.cameraComp) {
            console.log('HeadNeckTracker initComps() does not find camera');
            return false;
        }

        // record renderer entity visible
        let skinMeshRenderers = this.entity.getComponentsRecursive("SkinMeshRenderer");
        for (let i = 0; i < skinMeshRenderers.size(); i++) {
            let skinMeshRenderer = skinMeshRenderers.get(i);
            this.isVisible[skinMeshRenderer.entity.name] = skinMeshRenderer.enabled;
        }

        let meshRenderers = this.entity.getComponentsRecursive("MeshRenderer");
        for (let i = 0; i < meshRenderers.size(); i++) {
            let meshRenderer = meshRenderers.get(i);
            this.isVisible[meshRenderer.entity.name] = meshRenderer.enabled;
        }

        // get head transform
        let headRootTransform = this.entity.getComponent("Transform");
        if (headRootTransform === null) {
            console.log('HeadNeckTracker initComps() does not find transform');
            return false;
        }
        this.headTransform = headRootTransform;

        // find joint chain root transform
        let jointRootEntities = this.entity.scene.findEntitiesByName(JOINT_BONE_NAME[0], this.entity);
        if (jointRootEntities.size() > 0) {
            for (let j = 0; j < jointRootEntities.size(); j++) {
                let jointRootTransform = jointRootEntities.get(j).getComponent("Transform");
                if (jointRootTransform !== null) {
                    this.iterJointChain(jointRootTransform);
                }
            }

            // store init orientation
            for (let i = 0; i < this.jointChainTransforms.length; i++) {
                let jointTransformGroup = this.jointChainTransforms[i];
                let newJointInitWorldOrient = {};
                for (let key in jointTransformGroup) {
                    let jointTransform = jointTransformGroup[key];
                    let worldOrient = jointTransform.getWorldOrientation();
                    newJointInitWorldOrient[key] = worldOrient;
                    // console.log('HeadNeckTracker initComp joint: ', key, ' worlfOrient: ', worldOrient.toString());
                }
                this.jointChainInitWorldOrientations.push(newJointInitWorldOrient);
            }

            this.weights = {};
            this.updateWeights();
        } else {
            console.log('HeadNeckTracker initComps() does not find joint root entity');
        }
        this.sensorAgent = undefined;
    }

    createSensorAgent() {
        this.sensorAgent = Amaz.AmazingManager.getSingleton('Input').createDeviceSensorHub();

        if (this.sensorAgent) {
            this.sensorAgent.setSensorEnabled(Amaz.SensorType.Rotation, true);
            this.sensorAgent.setRefreshRate(Amaz.SensorType.Rotation, 100);
        }
    }

    /*
     * update weights
     */
    updateWeights() {
        this.weights[JOINT_BONE_NAME[1]] = this.secondJoint;
        this.weights[JOINT_BONE_NAME[2]] = this.thirdJoint;
        this.weights[JOINT_BONE_NAME[3]] = this.forthJoint;
        this.weights[JOINT_BONE_NAME[4]] = this.fifthJoint;
    }

    /* 
     * return first found camera in same layer as entity, or null
     */
    getCamera() {
        const entities = this.scene.entities;
        for (let i = 0; i < entities.size(); i++) {
            const entity = entities.get(i);
            const cameras = entity.getComponentsRecursive('Camera');
            for (let j = 0; j < cameras.size(); j++) {
                const camera = cameras.get(j);
                if (camera.isEntityVisible(this.entity)) {
                    return camera;
                }
            }
        }
        // No visible camera in layer
        return null;
    }

    /**
     * Find joint chain transform: iterate child transforms, it's a chain not a tree
     * @param {Transform} parentTransform - parent joint transform
     */
    iterJointChain(parentTransform) {
        let newJointGroup = {};
        newJointGroup[JOINT_BONE_NAME[0]] = parentTransform;
        let boneRootEntity = parentTransform.entity;
        let tempParentEntity = boneRootEntity;
        for (let i = 1; i < JOINT_BONE_NAME.length; i++) {
            let boneEntity = tempParentEntity.searchEntity(JOINT_BONE_NAME[i]);
            if (boneEntity) {
                let boneTransform = boneEntity.getComponent("Transform");
                newJointGroup[JOINT_BONE_NAME[i]] = boneTransform;
                tempParentEntity = boneTransform.entity;
            } else {
                console.log('HeadNeckTracker iterJointChain() lack of complete joints group or in wrong order');
                return;
            }
        }
        this.jointChainTransforms.push(newJointGroup);
    }

    /**
     * Update head root transform according to face tracking
     */
    updateBoneRenderer(parentTransform, projectionMatrix) {
        let children = parentTransform.children;
        for (let i = 0; i < children.size(); i++) {
            let child = children.get(i);
            if (child) {
                this.updateBoneRenderer(child, projectionMatrix);
            }
        }

        let parentEntity = parentTransform.entity;
        let comps = parentEntity.getComponents("Renderer");
        if (!comps) {
            return;
        }
        for (let j = 0; j < comps.size(); j++) {
            let comp = comps.get(j);
            if (comp.isInstanceOf('MeshRenderer') || comp.isInstanceOf('SkinMeshRenderer') || comp.isInstanceOf('ImageRenderer')) {
                // console.log('HeadNeckTracker updateBoneRenderer() entity: ', parentEntity.name);
                comp.useCustomProjectMatrix = true;
                comp.customProjectMatrix = projectionMatrix;
            }
        }
    }


    /**
     * Update head root transform according to face tracking
     */
    updateHeadRootTransform() {
        let calibrate = Amaz.AmazingManager.getSingleton("Calibrate");
        if (!calibrate) {
            return;
        }
        let faceCount = calibrate.faceCount;
        if (faceCount > 0) {
            this.detected = true;
        } else {
            this.detected = false;
        }

        for (let key in this.isVisible) {
            let rendererEntity = this.entity.searchEntity(key);
            if (rendererEntity && this.isVisible[key] === true) {
                let comps = rendererEntity.getComponents("Renderer");
                if (!comps) {
                    return;
                }
                for (let j = 0; j < comps.size(); j++) {
                    let comp = comps.get(j);
                    if (comp.isInstanceOf('MeshRenderer') || comp.isInstanceOf('SkinMeshRenderer') || comp.isInstanceOf('ImageRenderer')) {
                        if (this.faceId >= faceCount) {
                            comp.enabled = false;
                        } else {
                            comp.enabled = this.detected;
                        }
                    }
                }
            }
        }

        if (this.faceId < faceCount && this.detected === true) {
            const windowWidth = Amaz.AmazingManager.getSingleton('BuiltinObject').getOutputTextureWidth();
            const windowHeight = Amaz.AmazingManager.getSingleton('BuiltinObject').getOutputTextureHeight();
            const viewportSize = new Amaz.Vector2f(windowWidth, windowHeight);
            let pnpPMatrix = calibrate.getPnPPMatrix(this.faceId);
            // const scale = (windowWidth / windowHeight) / (720.0 / 1280.0);
            // pnpPMatrix.set(0, 0, pnpPMatrix.get(0, 0) / scale);
            this.cameraComp.projectionMatrix = pnpPMatrix;

            // let transformComp = this.entity.getComponent("Transform");
            // this.updateBoneRenderer(transformComp, pnpPMatrix);

            let pnpMMatrix = calibrate.getPnPMMatrix(this.faceId, this.cameraComp, false);
            this.headTransform.setWorldMatrix(pnpMMatrix);
        }
    }

    /**
     * Update neck joints based on given weights
     */
    updateNeckJoints() {
        if (this.detected === false) {
            return;
        }

        // fit divece rotation
        if (this.sensorAgent) {
            const deviceRotation = this.sensorAgent.getRotationData();
            let unitX = new Amaz.Vector3f(1.0, 0.0, 0.0);
            const rot = Amaz.Quaternionf.axisAngleToQuaternion(unitX, 0.5 * Math.PI);
            let rot1 = Amaz.Quaternionf.axisAngleToQuaternion(unitX, 1.0 * Math.PI);
            let headUpQua = rot.mul(deviceRotation.mul(rot1));

            let euler = headUpQua.quaternionToEuler();
            let deviceQuat = new Amaz.Quaternionf();
            deviceQuat = deviceQuat.eulerToQuaternion(new Amaz.Vector3f(0.0, 0.0, euler.z));
            // console.log('HeadNeckTracker euler.z: ', euler.z);

            this.jointChainCurWorldOrientations = [];
            for (let j = 0; j < this.jointChainInitWorldOrientations.length; j++) {
                let curOrient = {};
                for (let key in this.jointChainInitWorldOrientations[j]) {
                    let jointInitWorldOrient = this.jointChainInitWorldOrientations[j][key];
                    let jointCurWorldOrient = deviceQuat.mul(jointInitWorldOrient);
                    curOrient[key] = jointCurWorldOrient;
                }
                this.jointChainCurWorldOrientations.push(curOrient);
            }
        } else {
            this.createSensorAgent();
        }

        for (let i = 0; i < this.jointChainTransforms.length; i++) {
            for (let key in this.jointChainTransforms[i]) {

                let jointTransform = this.jointChainTransforms[i][key];
                if (key !== JOINT_BONE_NAME[0] && key !== JOINT_BONE_NAME[5]) {
                    let rootWorldOrient = this.jointChainTransforms[i][JOINT_BONE_NAME[0]].getWorldOrientation();
                    let interpolateWorldOrient = Amaz.Quaternionf.slerp(this.jointChainInitWorldOrientations[i][key], rootWorldOrient, this.weights[key]);
                    if (this.jointChainCurWorldOrientations.length > 0) {
                        interpolateWorldOrient = Amaz.Quaternionf.slerp(this.jointChainCurWorldOrientations[i][key], rootWorldOrient, this.weights[key]);
                    }
                    jointTransform.setWorldOrientation(interpolateWorldOrient);
                }
            }
        }
    }

    /**
     * @constructor
     */
    constructor() {
        this.name = SCRIPT_NAME;
        this.cameraComp = null;

        this.jointChainTransforms = [];
        this.jointChainInitWorldOrientations = [];
        this.jointChainCurWorldOrientations = [];
        this.jointChainNameMap = {};
        this.headTransform = null;
        this.isVisible = {};

        this.detected = false;
        this.orientation = new Amaz.Quaternionf(0.0, 0.0, 0.0, 1.0);
    }

    onStart() {
        this.initialized = false;

        // init comp
        let result = this.initComps();
        if (result === false) {
            console.log('HeadNeckTracker onStart() init failed');
            return;
        }

        this.initialized = true;
    }


    onUpdate(dt) {
        if (this.initialized === false) {
            return;
        }

        this.updateHeadRootTransform();
        if (this.jointChainTransforms.length > 0) {
            this.updateWeights();
            this.updateNeckJoints();
        }
    }

    onDestroy(){
        // reset visibility when destory
        for (let key in this.isVisible) {
            let rendererEntity = this.entity.searchEntity(key);
            if (rendererEntity) {
                let comps = rendererEntity.getComponents("Renderer");
                if (!comps) {
                    return;
                }
                for (let j = 0; j < comps.size(); j++) {
                    let comp = comps.get(j);
                    comp.enabled = this.isVisible[key];
                }
            }
        }
    }
}

exports.HeadNeckTracker = HeadNeckTracker;